import hoistStatics from 'hoist-non-react-statics'
import invariant from 'invariant'
import { Component, createElement } from 'react'

import Subscription from '../utils/Subscription'
import { storeShape, subscriptionShape } from '../utils/PropTypes'

let hotReloadingVersion = 0
const dummyState = {}
function noop() {}
function makeSelectorStateful(sourceSelector, store) {
  // wrap the selector in an object that tracks its results between runs.
  const selector = {
    run: function runComponentSelector(props) {
      try {
        const nextProps = sourceSelector(store.getState(), props)
        if (nextProps !== selector.props || selector.error) {
          selector.shouldComponentUpdate = true
          selector.props = nextProps
          selector.error = null
        }
      } catch (error) {
        selector.shouldComponentUpdate = true
        selector.error = error
      }
    }
  }

  return selector
}

/**
 * 根据的使用方法：
 * connect(
 *   mapStateToProps(state,ownProps)=>stateProps:Object, 
 *   mapDispatchToProps(dispatch, ownProps)=>dispatchProps:Object, 
 *   mergeProps(stateProps, dispatchProps, ownProps)=>props:Object,
 *   options:Object
 *  )=>(
 *    component
 *  )=>component
 * 1.使用该方法后，返回一个包裹原先定义的xxxComponent的新的newReactComponent
 * 2.connect方法执行后返回wrapWithConnect函数，在其内部形成一个闭包，保存了传入的state和action等信息。
 * 并且执行该函数后，返回包裹后的newReactComponent，而该组件通过render原组件，形成对原组件的封装。
 * 3. 渲染页面需要store tree（通过context获取provider中的store）中的state片段，变更state需要dispatch action，这两处信息，就是在调用connect时，
 * 作为参数传入的mapStateToProps函数（映射关系：react-redux内部调用该函数，并把state作为参数传入，该函数也称为selector）
 * 和mapDispatchToProps函数（映射关系：在函数定义时，引用外部自定义action，react-redux内部调用该函数，并把store.dispatch作为参数传入，该函数也称为selector），
 * 包裹后的newReactComponent组件通过设置原组件的props属性传入信息到原组件。
 * 
 */
export default function connectAdvanced(
  /*
  selector具有过滤筛选的作用，这里是根据条件生成WrappedComponent的props。
  而selectorFactory的作用是根据参数生成这样的selector。
  https://github.com/reactjs/reselect  reselect 结合redux使用，提供功能： 生成具有记忆功能的selector函数

    selectorFactory is a func that is responsible for returning the selector function used to
    compute new props from state, props, and dispatch. For example:

      export default connectAdvanced((dispatch, options) => (state, props) => ({
        thing: state.things[props.thingId],
        saveThing: fields => dispatch(actionCreators.saveThing(props.thingId, fields)),
      }))(YourComponent)

    Access to dispatch is provided to the factory so selectorFactories can bind actionCreators
    outside of their selector as an optimization. Options passed to connectAdvanced are passed to
    the selectorFactory, along with displayName and WrappedComponent, as the second argument.

    Note that selectorFactory is responsible for all caching/memoization of inbound and outbound
    props. Do not use connectAdvanced directly without memoizing results between calls to your
    selector, otherwise the Connect component will re-render on every state or props change.
  */
  selectorFactory,
  // options object:
  {
    // the func used to compute this HOC's displayName from the wrapped component's displayName.
    // probably overridden by wrapper functions such as connect()
    getDisplayName = name => `ConnectAdvanced(${name})`,

    // shown in error messages
    // probably overridden by wrapper functions such as connect()
    methodName = 'connectAdvanced',

    // if defined, the name of the property passed to the wrapped element indicating the number of
    // calls to render. useful for watching in react devtools for unnecessary re-renders.
    renderCountProp = undefined,

    // determines whether this HOC(高阶组件) subscribes to store changes
    shouldHandleStateChanges = true,

    // the key of props/context to get the store
    //<Provider store={store} store2={store2}></Provider>
    //默认为store，storeKey是为了从props或者context获取到store。默认为store。一般不会有多个store。
    storeKey = 'store',

    // if true, the wrapped element is exposed by this HOC via the getWrappedInstance() function.
    withRef = false,

    // additional options are passed through to the selectorFactory
    ...connectOptions
  } = {}
) {
  const subscriptionKey = storeKey + 'Subscription'
  const version = hotReloadingVersion++

  const contextTypes = {
    [storeKey]: storeShape,
    [subscriptionKey]: subscriptionShape,
  }
  const childContextTypes = {
    [subscriptionKey]: subscriptionShape,
  }

  return function wrapWithConnect(WrappedComponent) {
    invariant(
      typeof WrappedComponent == 'function',
      `You must pass a component to the function returned by ` +
      `connect. Instead received ${JSON.stringify(WrappedComponent)}`
    )

    const wrappedComponentName = WrappedComponent.displayName
      || WrappedComponent.name
      || 'Component'

    const displayName = getDisplayName(wrappedComponentName)

    const selectorFactoryOptions = {
      ...connectOptions,
      getDisplayName,
      methodName,
      renderCountProp,
      shouldHandleStateChanges,
      storeKey,
      withRef,
      displayName,
      wrappedComponentName,
      WrappedComponent
    }

    class Connect extends Component {
      constructor(props, context) {
        super(props, context)

        this.version = version
        this.state = {}
        this.renderCount = 0
        //获取store的方式：
        //1.通过props传递store，<connectedComponent store={innerStore}>
        //2.通过context获取store，<Provider store={outStore}>
        //通过props获取store的方式优先级更高
        this.store = props[storeKey] || context[storeKey]
        this.propsMode = Boolean(props[storeKey])
        this.setWrappedInstance = this.setWrappedInstance.bind(this)

        invariant(this.store,
          `Could not find "${storeKey}" in either the context or props of ` +
          `"${displayName}". Either wrap the root component in a <Provider>, ` +
          `or explicitly pass "${storeKey}" as a prop to "${displayName}".`
        )
        //selector的作用是：通过过滤state和ownProps生成，生成wrappedComponent的props。
        this.initSelector()
        //subscription作用：监听state和ownProps的变化，触发wrappedComponent更新。
        this.initSubscription()
      }

      getChildContext() {
        // If this component received store from props, its subscription should be transparent
        // to any descendants receiving store+subscription from context; it passes along
        // subscription passed to it. Otherwise, it shadows the parent subscription, which allows
        // Connect to control ordering of notifications to flow top-down.
        //意思是说：如果这个组件从props得到store，那么这个组件的subscription对于后代来说应该透明，
        //它的后代要通过context获取store和subscription，而这个subscription要通过这里的[subscriptionKey]传递.
        //否则，[subscriptionKey]传递的是this.subscription，这样就可以达到自上而下的通知的目的。
        //子组件的getChildContext()返回的对象和父组件的getChildContext()返回的对象进行比较
        //他们的childContextType相同时，
        //如果有相同的键，则父组件中的键值会被覆盖。
        //如果子组件只返回childContextType要求一部分，父组件的中返回的对象同样会被传递。
        const subscription = this.propsMode ? null : this.subscription
        return { [subscriptionKey]: subscription || this.context[subscriptionKey] }
        //这里的[subscriptionKey]是暴露给子容器元素的。它们可以通过this.context[subscriptionKey] 获取。
      }

      componentDidMount() {
        if (!shouldHandleStateChanges) return

        // componentWillMount fires during server side rendering, but componentDidMount and
        // componentWillUnmount do not. Because of this, trySubscribe happens during ...didMount.
        // Otherwise, unsubscription would never take place during SSR, causing a memory leak.
        // To handle the case where a child component may have triggered a state change by
        // dispatching an action in its componentWillMount, we have to re-run the select and maybe
        // re-render.
        this.subscription.trySubscribe()
        this.selector.run(this.props)
        if (this.selector.shouldComponentUpdate) this.forceUpdate()
      }

      componentWillReceiveProps(nextProps) {
        this.selector.run(nextProps)
      }

      shouldComponentUpdate() {
        return this.selector.shouldComponentUpdate
      }

      componentWillUnmount() {
        if (this.subscription) this.subscription.tryUnsubscribe()
        this.subscription = null
        this.notifyNestedSubs = noop
        this.store = null
        this.selector.run = noop
        this.selector.shouldComponentUpdate = false
      }

      getWrappedInstance() {
        invariant(withRef,
          `To access the wrapped instance, you need to specify ` +
          `{ withRef: true } in the options argument of the ${methodName}() call.`
        )
        return this.wrappedInstance
      }

      setWrappedInstance(ref) {
        this.wrappedInstance = ref
      }

      initSelector() {
        const sourceSelector = selectorFactory(this.store.dispatch, selectorFactoryOptions)
        this.selector = makeSelectorStateful(sourceSelector, this.store)
        this.selector.run(this.props)
      }

      initSubscription() {
        if (!shouldHandleStateChanges) return

        // parentSub's source should match where store came from: props vs. context. A component
        // connected to the store via props shouldn't use subscription from context, or vice versa(反之亦然).
        //如果组件通过props连接store，则不应该从context获取subscription。
        const parentSub = (this.propsMode ? this.props : this.context)[subscriptionKey]
        this.subscription = new Subscription(this.store, parentSub, this.onStateChange.bind(this))

        // `notifyNestedSubs` is duplicated to handle the case where the component is  unmounted in
        // the middle of the notification loop, where `this.subscription` will then be null. An
        // extra null check every change can be avoided by copying the method onto `this` and then
        // replacing it with a no-op on unmount. This can probably be avoided if Subscription's
        // listeners logic is changed to not call listeners that have been unsubscribed in the
        // middle of the notification loop.
        this.notifyNestedSubs = this.subscription.notifyNestedSubs.bind(this.subscription)
      }

      onStateChange() {
        this.selector.run(this.props)

        if (!this.selector.shouldComponentUpdate) {
          this.notifyNestedSubs()//父组件不需要更新，只需要通知子组件更新。
        } else {
          //父组件更新，然后更新完成后，通知子组件更新
          this.componentDidUpdate = this.notifyNestedSubsOnComponentDidUpdate
          this.setState(dummyState) 
        }
      }

      notifyNestedSubsOnComponentDidUpdate() {
        // `componentDidUpdate` is conditionally implemented when `onStateChange` determines it
        // needs to notify nested subs. Once called, it unimplements itself until further state
        // changes occur. Doing it this way vs having a permanent `componentDidMount` that does
        // a boolean check every time avoids an extra method call most of the time, resulting
        // in some perf boost.
        this.componentDidUpdate = undefined
        this.notifyNestedSubs()
      }

      isSubscribed() {
        return Boolean(this.subscription) && this.subscription.isSubscribed()
      }

      addExtraProps(props) {
        if (!withRef && !renderCountProp && !(this.propsMode && this.subscription)) return props
        // make a shallow copy so that fields added don't leak to the original selector.
        // this is especially important for 'ref' since that's a reference back to the component
        // instance. a singleton memoized selector would then be holding a reference to the
        // instance, preventing the instance from being garbage collected, and that would be bad
        const withExtras = { ...props }
        if (withRef) withExtras.ref = this.setWrappedInstance
        if (renderCountProp) withExtras[renderCountProp] = this.renderCount++
        if (this.propsMode && this.subscription) withExtras[subscriptionKey] = this.subscription
        return withExtras
      }

      render() {
        const selector = this.selector
        selector.shouldComponentUpdate = false

        if (selector.error) {
          throw selector.error
        } else {
          return createElement(WrappedComponent, this.addExtraProps(selector.props))
        }
      }
    }

    Connect.WrappedComponent = WrappedComponent
    Connect.displayName = displayName
    Connect.childContextTypes = childContextTypes 
    //在父组件中通过getChildContext设置传递的值，并设置childContextTypes属性，
    //在后代组件中设置contextTypes后，可以通过this.context.XXX 读取设置的要传递的值。
    //Provider和connect高阶组件
    Connect.contextTypes = contextTypes
    Connect.propTypes = contextTypes

    if (process.env.NODE_ENV !== 'production') {
      Connect.prototype.componentWillUpdate = function componentWillUpdate() {
        // We are hot reloading!
        if (this.version !== version) {
          this.version = version
          this.initSelector()

          if (this.subscription) this.subscription.tryUnsubscribe()
          this.initSubscription()
          if (shouldHandleStateChanges) this.subscription.trySubscribe()
        }
      }
    }

    return hoistStatics(Connect, WrappedComponent)
    //将WrappedComponent的属性整合到Connect组件上，最后返回的是高阶组件Connect。
  }
}
