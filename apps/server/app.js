import Koa from 'koa'
import jwt from 'koa-jwt'
import cors from '@koa/cors'
import bodyParser from 'koa-bodyparser'
import logger from 'koa-logger'
import { koaBody } from 'koa-body'
import path from 'path'
import fs from 'fs'
import mime from 'mime-types'
import send from 'koa-send'

import config from './config/index.js'
import mongo from './lib/mongo.js'
// import redis from './lib/redis.js'

import router from './route/index.js'

const app = new Koa()

// 设置允许跨域请求
app.use(cors())

// 静态文件目录
const staticDir = path.join(process.cwd(), 'assets')
console.log('Static files directory:', staticDir)

// 确保静态文件目录存在
if (!fs.existsSync(staticDir)) {
  console.log('Creating static directory:', staticDir)
  fs.mkdirSync(staticDir, { recursive: true })
}

// 添加视频文件的特殊处理
app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/assets/video/') && ctx.path.endsWith('.mp4')) {
    const filePath = ctx.path.replace('/assets/', '')
    const range = ctx.headers.range
    const videoPath = path.join(process.cwd(), 'assets', filePath)

    try {
      const stats = fs.statSync(videoPath)
      const fileSize = stats.size

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
        const chunksize = (end - start) + 1

        ctx.set({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4'
        })
        ctx.status = 206

        const stream = fs.createReadStream(videoPath, { start, end })
        ctx.body = stream
      } else {
        ctx.set({
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes'
        })
        ctx.status = 200
        
        const stream = fs.createReadStream(videoPath)
        ctx.body = stream
      }
    } catch (error) {
      console.error('Video streaming error:', error)
      ctx.status = 500
      ctx.body = 'Internal Server Error'
    }
  } else {
    await next()
  }
})

// 静态文件服务保持不变
app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/assets/')) {
    try {
      await send(ctx, ctx.path.slice(8), {
        root: path.join(process.cwd(), 'assets'),
        setHeaders: (res) => {
          res.setHeader('Access-Control-Allow-Origin', '*')
        }
      })
    } catch (err) {
      await next()
    }
  } else {
    await next()
  }
})

// 设置上传文件大小最大限制
app.use(
  koaBody({
    multipart: true,
    formidable: {
      maxFileSize: 200 * 1024 * 1024, // 增加到 200MB
      keepExtensions: true,           // 保持文件扩展名
      multiples: true,               // 支持多文件上传
      uploadDir: path.join(process.cwd(), 'temp'), // 临时文件目录
      onFileBegin: (name, file) => {
        // 确保临时目录存在
        const uploadDir = path.join(process.cwd(), 'temp')
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true })
        }
      }
    },
    urlencoded: true,
    json: true
  })
)
// 分析http请求体
app.use(bodyParser())
//输出请求的方法，url,和所花费的时间
app.use(logger())
// jwt 登陆验证
app.use(
  jwt({ secret: config.jwt.secret, debug: true }).unless({
    path: [
      '/api/admin/auth/signin',
      '/api/admin/auth/init',
      /\/api\/public\/*/,
      /\/api\/oauth\/*/,
      /^\/assets\/.*/
    ]
  })
)
// 主入口
// 中间件，拦截器都在这里配置。
// 路由相关的内容放在 router/index.js 中
app.use(router.middleware())

console.log('当前环境:', process.env.PLATFORM)
//初始化redis和mongo,并监听端口
// await redis.init()
await mongo.init()
//监听端口
app.listen(config.app.port, '0.0.0.0', () => {
  console.log('The server is running at', config.app.host)
})
//如果是开发环境，不需要监听进程的关闭事件
if (process.env.PLATFORM != 'DEV') {
  process.send && process.send('ready')
  process.on('SIGINT', async function () {
    try {
      console.log('KOA 停止服务....')
      // await redis.close()
      await mongo.close()
      process.exit(0)
    } catch (error) {
      process.exit(1)
    }
  })
}
