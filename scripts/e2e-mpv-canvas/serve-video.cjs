// 临时 HTTP 视频服务（测试 libmpv 网络流播放路径）
const http = require('http')
const fs = require('fs')
const path = process.argv[2] || 'C://Users//yn//Videos//小乖解压.mp4'
const stat = fs.statSync(path)
const server = http.createServer((req, res) => {
  const range = req.headers.range || ''
  const m = range.match(/bytes=(\d+)-(\d*)/)
  if (m) {
    const start = parseInt(m[1], 10)
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4'
    })
    fs.createReadStream(path, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' })
    fs.createReadStream(path).pipe(res)
  }
})
server.listen(18923, () => console.log('VIDEO_SERVER_READY http://127.0.0.1:18923/video.mp4'))
