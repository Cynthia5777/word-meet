# 同词相遇

联想默契小游戏。Node.js + WebSocket,**房间状态全在内存里,无数据库**;一个进程可同时承载很多房间。

## 本地运行
    npm install && npm start      # http://localhost:3000
    npm test                      # 端到端测试(20 房间并发等)

## 部署(任何能跑常驻 Node 进程、支持 WebSocket 的平台)
Render / Railway / Fly.io / Zeabur / 自己的 VPS:构建 `npm install`,启动 `npm start`,读取 `PORT` 环境变量。
Vercel / Netlify Functions 这类 serverless 不支持长连接,不能用。
单实例即可;若要横向扩容,需按房间号做会话粘滞。

## 部署到 Render
1. 把项目推到 GitHub(`package-lock.json` 要一起提交,`render.yaml` 里用的是 `npm ci`)。
2. Render 控制台 → New → **Blueprint** → 选这个仓库,会自动读取 `render.yaml` 创建服务。
   (也可以 New → Web Service 手动填:Build `npm ci`,Start `npm start`,Health Check Path `/healthz`)
3. 部署完成后访问 `https://word-meet-xxxx.onrender.com` 即可,HTTPS/WSS 自动配置。
4. free 档会休眠、重启会丢房间;长期使用把 `render.yaml` 里的 `plan` 改成 `starter`。

## 可调参数(server.js 顶部)
WRITE_MS 每轮写词时限 · MAX_PLAYERS 房间人数 · GRACE_MS 掉线保留座位时间 · MAX_ROOMS 房间上限
