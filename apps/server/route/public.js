import md5 from 'md5'
import moment from 'moment/moment.js'
import mongo from '#@/lib/mongo.js'
import { success, fail, jwtoken } from '#@/lib/response.js'
import util from '#@/lib/util.js'
import config from '#@/config/index.js'
import { readFile } from 'fs/promises'
import jwt from 'jsonwebtoken'
import { ObjectId } from 'mongodb'
import S3 from 'aws-sdk/clients/s3.js'
import fs from 'fs'
import path from 'path'
import dayjs from 'dayjs'
import mime from 'mime-types'
import { createHash } from 'crypto'
import ffmpeg from 'fluent-ffmpeg'

const uploadS3 = async (filepath, filename) => {
  // 确保目录存在
  const assetsDir = path.join(process.cwd(), 'assets')
  const targetDir = path.dirname(path.join(assetsDir, filename))
  
  console.log('Current working directory:', process.cwd())
  console.log('Assets directory:', assetsDir)
  console.log('Target directory:', targetDir)
  
  if (!fs.existsSync(targetDir)) {
    console.log('Creating directory:', targetDir)
    fs.mkdirSync(targetDir, { recursive: true })
  }

  // 目标文件路径
  const targetPath = path.join(assetsDir, filename)
  console.log('Target file path:', targetPath)
  
  // 复制文件
  await fs.promises.copyFile(filepath, targetPath)
  
  // 验证文件是否存在
  const exists = fs.existsSync(targetPath)
  console.log('File exists after copy:', exists)
  
  // 返回完整的URL，包含baseUrl前缀
  const url = `${config.app.host}/assets/${filename}`
  console.log('Generated URL:', url)
  console.log('File is accessible:', fs.existsSync(targetPath))
  
  return url
}

export default {
  async index(ctx) {
    success(ctx, {
      name: process.env.npm_package_name,
      version: process.env.npm_package_version
    })
  },
  // 上传文件，头像，视频，等等
  async upload(ctx) {
    try {
      const start = new Date().getTime()
      const exts = ['jpg', 'jpge', 'jpeg', 'png', 'webp', 'mp4']
      const { filepath, mimetype } = ctx.request.files.file
      const fileExtension = mime.extension(mimetype)
      
      if (!exts.includes(fileExtension)) {
        fail(ctx, '文件类型错误')
        return
      }
      
      console.log('Upload file:', filepath, fileExtension)
      
      // 计算文件的md5
      const buff = fs.readFileSync(filepath)
      const hash = createHash('md5').update(buff).digest('hex')

      let url = ''

      try {
        if (fileExtension === 'mp4') {
          // 获取视频信息
          const videoInfo = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filepath, (err, metadata) => {
              if (err) reject(err)
              else resolve(metadata)
            })
          })

          // 判断视频方向
          const isVertical = videoInfo.streams[0].height > videoInfo.streams[0].width
          
          // 构建文件名，包含方向信息
          const orientation = isVertical ? 'vertical' : 'horizontal'
          const filename = `video/${dayjs().format('YYYYMMDD')}/${orientation}_${hash}.${fileExtension}`
          
          // 确保视频目录存在
          const videoDir = path.join(process.cwd(), 'assets/video', dayjs().format('YYYYMMDD'))
          if (!fs.existsSync(videoDir)) {
            fs.mkdirSync(videoDir, { recursive: true })
          }
          
          // 确保截图目录存在
          const screenshotDir = path.join(process.cwd(), 'assets/screenshots')
          if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, { recursive: true })
          }

          // 处理视频截图
          await new Promise((resolve, reject) => {
            ffmpeg(filepath)
              .on('end', async function () {
                resolve()
              })
              .on('error', function(err) {
                console.error('Screenshot error:', err)
                resolve() // 即使截图失败也继续
              })
              .screenshots({
                timestamps: [0],
                filename: `${hash}.png`,
                folder: screenshotDir
              })
          })

          // 复制视频文件
          await fs.promises.copyFile(filepath, path.join(process.cwd(), 'assets', filename))
          url = `${config.app.host}/assets/${filename}`
        } else {
          // 头像或者图片上传
          const filename = `avatar/${dayjs().format('YYYYMMDD')}/${hash}.${fileExtension}`
          url = await uploadS3(filepath, filename)
        }

        // 删除临时文件
        fs.unlinkSync(filepath)

        success(ctx, {
          url,
          key: hash
        })
      } catch (error) {
        console.error('Upload processing error:', error)
        throw error
      }
    } catch (error) {
      console.error('Upload error:', error)
      fail(ctx, error.message)
    }
  },
  // 注册匿名用户
  async anonymous(ctx) {
    try {
      const username = 'Visitor' + util.randomString(4, 3)
      const password = 'iloveshorttv'
      const passwordHash = md5(password + config.jwt.saltkey)
      const document = {
        username,
        password: passwordHash,
        avatar: '/static/avatar.jpg',
        pass: true,
        guestname: username,
        guest: true,
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime()
      }
      const ret = await mongo.col('user').insertOne(document)
      const data = {
        token: jwt.sign({ _id: ret.insertedId, username }, config.jwt.secret, {
          expiresIn: '365d'
        }),
        user: document
      }

      success(ctx, data)
    } catch (err) {
      console.log(err.message)
      fail(ctx, 'Server error')
    }
  },
  // 用户注册
  async register(ctx) {
    try {
      const { username, password, repassword, mobile, _id } = ctx.request.body

      const user = await mongo.col('user').findOne({ username })

      if (user && user.username === username) {
        fail(ctx, 'The username already exists')
        return
      }
      if (password != repassword) {
        fail(ctx, 'Password and repassword are not the same')
        return
      }

      const passwordHash = md5(password + config.jwt.saltkey)
      const document = {
        username,
        password: passwordHash,
        avatar: '/static/avatar.jpg',
        guest: false,
        pass: true,
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime()
      }
      const ret = await mongo
        .col('user')
        .updateOne(
          { _id: new ObjectId(_id) },
          { $set: document },
          { upsert: true }
        )

      const userid = ret.upsertedId || _id
      document['_id'] = userid

      jwtoken(ctx, document)
    } catch (err) {
      console.log(err.message)
      fail(ctx, 'Server error')
    }
  },

  // 用户登录
  async login(ctx) {
    try {
      const { username, password } = ctx.request.body
      // console.log('/login', username, password)
      const res = await mongo.col('user').findOne({ username, pass: true })

      if (!res) {
        fail(ctx, 'The user does not exist')
        return
      }
      if (res.password !== md5(password + config.jwt.saltkey)) {
        fail(ctx, 'Wrong password')
        return
      }
      delete res.password

      jwtoken(ctx, res)
    } catch (e) {
      console.log(e)
      fail(ctx, 'Server error')
    }
  },
  // 首页推荐内容
  async home(ctx) {
    const recommend = await mongo
      .col('series')
      .find()
      .limit(10)
      .toArray()

    // 替换所有图片 URL 中的 localhost 为实际 IP
    const replaceUrls = (data) => {
      if (Array.isArray(data.cover)) {
        data.cover = data.cover.map(url => 
          url.replace('http://localhost:2000', config.app.host)
        )
      }
      return data
    }

    // 处理推荐数据
    const processedRecommend = recommend.map(replaceUrls)

    const category = await mongo
      .col('category')
      .find({
        pass: true
      })
      .toArray()

    const categorys = []
    for (const cat of category) {
      const series = await mongo
        .col('series')
        .find({
          category: cat._id.toString()
        })
        .limit(10)
        .toArray()

      // 处理分类数据
      const processedSeries = series.map(replaceUrls)

      if (processedSeries.length > 0) {
        categorys.push({
          name: cat.name,
          series: processedSeries
        })
      }
    }

    const release = await mongo
      .col('series')
      .find({
        pass: true
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray()

    // 处理最新发布数据
    const processedRelease = release.map(replaceUrls)

    const data = { 
      recommend: processedRecommend, 
      categorys, 
      release: processedRelease 
    }
    success(ctx, data)
  },

  // 随机短视频
  async short(ctx) {
    const episodes = await mongo
      .col('episode')
      .aggregate([
        {
          $match: {
            // series: '656f41e0830eeb0eb93471b5'  // Oppenheimer
            // series: '6571a29ba21c5f2d89cf2d99',
            'video.0': { $exists: true },
            'cover.0': { $exists: true }
          }
        },
        {
          $limit: 10
        },
        {
          $lookup: {
            from: 'like',
            localField: 'series',
            foreignField: 'series',
            as: 'likeList',
            pipeline: [
              { $match: { user: { $eq: '65731d824b4efadf4b82a93d' } } }
            ]
          }
        },
        {
          $addFields: {
            isLike: { $toBool: { $size: '$likeList' } }
          }
        },
        // { $addFields: { video: { $first: '$video' } } },
        // { $addFields: { cover: { $first: '$cover' } } },
        {
          $project: {
            likeList: 0
          }
        }
      ])
      .toArray()

    try {
      success(ctx, episodes)
    } catch (error) {
      fail(ctx, 'Server error')
    }
  },
  // 获取某一个剧集的所有信息
  // TODO 某些没付款的信息不能返回。
  async series(ctx) {
    const { id } = ctx.request.body

    const episodes = await mongo
      .col('episode')
      .find({
        series: id
      })
      .sort({ episode: 1 })
      .toArray()

    try {
      success(ctx, episodes)
    } catch (error) {
      fail(ctx, 'Server error')
    }
  }
}
