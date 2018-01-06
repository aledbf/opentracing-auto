'use strict'

const debug = require('debug')('opentracing-auto:instrumentation:koa')
const co = require('co')
const { Tags, FORMAT_HTTP_HEADERS } = require('opentracing')
const shimmer = require('shimmer')
const cls = require('../cls')

const METHODS = ['use']
const OPERATION_NAME = 'http_server'
const TAG_REQUEST_PATH = 'request_path'

function patch (koa, tracers) {
  function applicationActionWrap (method) {
    return function applicationActionWrapped (...args) {
      if (!this._jaeger_trace_patched && !this._router) {
        this._jaeger_trace_patched = true
        this.use(middleware)
      }
      return method.call(this, ...args)
    }
  }

  function * middleware (next) {
    const self = this
    return cls.runPromise(co.wrap(function * () {
      // start
      const url = `${self.protocol}://${self.host}${self.url}`
      const parentSpanContexts = tracers.map((tracer) => tracer.extract(FORMAT_HTTP_HEADERS, self.headers))
      const spans = parentSpanContexts.map((parentSpanContext, key) =>
        cls.startRootSpan(tracers[key], OPERATION_NAME, {
          childOf: parentSpanContext,
          tags: {
            [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
            [Tags.HTTP_URL]: url,
            [Tags.HTTP_METHOD]: self.method
          }
        }))
      debug(`Operation started ${OPERATION_NAME}`, {
        [Tags.HTTP_URL]: url,
        [Tags.HTTP_METHOD]: self.method
      })

      if (self.request.socket.remoteAddress) {
        spans.forEach((span) => span.log({ peerRemoteAddress: self.request.socket.remoteAddress }))
      }

      yield next

      // end
      spans.forEach((span) => span.setTag(TAG_REQUEST_PATH, self.path))
      spans.forEach((span) => span.setTag(Tags.HTTP_STATUS_CODE, self.status))

      if (self.status >= 400) {
        spans.forEach((span) => span.setTag(Tags.ERROR, true))

        debug(`Operation error captured ${OPERATION_NAME}`, {
          reason: 'Bad status code',
          statusCode: self.status
        })
      }

      spans.forEach((span) => span.finish())

      debug(`Operation finished ${OPERATION_NAME}`, {
        [Tags.HTTP_STATUS_CODE]: self.status
      })
    }))
  }

  METHODS.forEach((method) => {
    shimmer.wrap(koa.prototype, method, applicationActionWrap)
    debug(`Method patched ${method}`)
  })

  debug('Patched')
}

function unpatch (koa) {
  METHODS.forEach((method) => {
    shimmer.unwrap(koa.prototype, method)
    debug(`Method unpatched ${method}`)
  })

  debug('Unpatched')
}

module.exports = {
  name: 'koa',
  module: 'koa',
  supportedVersions: ['1.x'],
  TAG_REQUEST_PATH,
  OPERATION_NAME,
  patch,
  unpatch
}