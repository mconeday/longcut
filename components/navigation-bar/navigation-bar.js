/* 导航栏组件，源码取自 wechat-miniprogram/weui-miniprogram（MIT），已改为 JS 并内联样式 */
Component({
  options: {
    multipleSlots: true
  },
  properties: {
    extClass: { type: String, value: '' },
    title: { type: String, value: '' },
    background: { type: String, value: '' },
    color: { type: String, value: '' },
    back: { type: Boolean, value: true },
    loading: { type: Boolean, value: false },
    animated: { type: Boolean, value: true },
    show: { type: Boolean, value: true, observer: '_showChange' },
    delta: { type: Number, value: 1 }
  },
  data: {
    displayStyle: '',
    ios: false,
    statusBarHeight: 0
  },
  attached() {
    try {
      const info = wx.getSystemInfoSync()
      this.setData({
        ios: !!(info.system && info.system.toLowerCase().indexOf('ios') + 1),
        statusBarHeight: info.statusBarHeight || 0
      })
    } catch (e) {}
  },
  methods: {
    _showChange(show) {
      const animated = this.data.animated
      let displayStyle = ''
      if (animated) {
        displayStyle = 'opacity: ' + (show ? '1' : '0') +
          ';-webkit-transition:opacity 0.5s;transition:opacity 0.5s;'
      } else {
        displayStyle = 'display: ' + (show ? '' : 'none')
      }
      this.setData({ displayStyle })
    },
    back() {
      const data = this.data
      if (data.delta) {
        wx.navigateBack({ delta: data.delta })
      }
      this.triggerEvent('back', { delta: data.delta }, {})
    }
  }
})
