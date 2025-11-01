import express from 'express';
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

interface Info {
  process: ChildProcess;
  startTime: number;
  url: string;
  activeTime?: number;
}

const debug = process.env.DEBUG === 'true';
const dist = 'output';
const app = express();
const PORT = 7677;
const STREAM_DIR = path.resolve(`./${dist}`);

const streams = new Map<string, Info>();
const channels: { channel: ''; url: '' }[] = JSON.parse(
  fs.readFileSync(path.resolve('./channels.json'), 'utf-8')?.toString() ?? '[]'
);

if (!fs.existsSync(STREAM_DIR)) {
  fs.mkdirSync(STREAM_DIR, { recursive: true });
}

app.use(`/${dist}`, express.static(STREAM_DIR));

app.get('/api/stream/', async (req, res) => {
  const { channel } = req.query;
  if (!channel || !channels.find((c) => c.channel === channel)) {
    return res.status(400).send('Invalid channel');
  }

  const ch = channel as string;
  const m3uPath = path.join(STREAM_DIR, `${ch}.m3u8`);
  const streamUrl = `http://${req.hostname}:${PORT}/${dist}/${ch}.m3u8`;

  // 等待文件存在且有内容
  async function waitForFile(
    filePath: string,
    timeout = 15000,
    interval = 300
  ) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const st = await fs.promises.stat(filePath);
        if (st.size && st.size > 0) return true;
      } catch (e) {
        // file not ready
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return false;
  }

  // 启动转码的抽离函数
  function startTranscoder(channelName: string, srcUrl: string | undefined) {
    if (!srcUrl) return;

    // 设置 base URL 让 ffmpeg 生成正确的片段路径
    const baseUrl = `/${dist}/`; // 使用相对路径，避免硬编码主机名

    const args = [
      '-i',
      srcUrl,
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '5',
      '-hls_list_size',
      '5',
      '-hls_flags',
      'delete_segments',
      // 添加 base_url 参数，这样生成的 m3u8 中的 ts 路径会带上这个前缀
      '-hls_base_url',
      baseUrl,
      '-hls_segment_filename',
      `${STREAM_DIR}/${channelName}_%03d.ts`,
      `${STREAM_DIR}/${channelName}.m3u8`,
    ];
    // 打印用于调试的 ffmpeg 命令
    +console.log('🧰 ffmpeg command:', 'ffmpeg', args.join(' '));

    const list: any[] = debug ? ['ignore', 'pipe', 'pipe'] : ['ignore'];

    const proc = spawn('ffmpeg', args, { stdio: list });
    proc.unref();
    streams.set(channelName, {
      process: proc,
      startTime: Date.now(),
      url: srcUrl,
      activeTime: Date.now(),
    });

    console.log(
      `▶️ ffmpeg pid=${(proc as any).pid} started for ${channelName}`
    );

    proc.stdout?.on('data', (d) => {
      console.log(`[ffmpeg ${channelName} stdout]`, d.toString());
    });
    proc.stderr?.on('data', (d) => {
      console.error(`[ffmpeg ${channelName} stderr]`, d.toString());
    });

    proc.on('error', (err) => {
      console.error(`❌ ffmpeg error for ${channelName}:`, err);
    });

    proc.on('exit', () => {
      console.log(`🛑 Transcoder stopped for ${channelName}`);
      streams.delete(channelName);
    });
  }

  const isNew = !streams.has(ch);
  if (isNew) {
    console.log(`🚀 Starting transcoder for ${ch}`);
    const url = channels.find((c) => c.channel === ch)?.url;
    startTranscoder(ch, url);
  }

  // 根据是否新启动决定等待超时（新启动给更长时间）
  const waitTimeout = isNew ? 15000 : 3000;
  // 不管等待结果如何,都重定向到相同的 URL
  await waitForFile(m3uPath, waitTimeout);
  return res.redirect(streamUrl);
});

// 拦截静态请求：记录访问时间
app.use(`/${dist}`, (req, res, next) => {
  // 提取频道名
  const match = req.path.match(/^\/([^_\/]+)(?:_|\.m3u8)/);
  if (match) {
    const channel = match[1];
    const info = streams.get(channel);
    if (info) {
      info.activeTime = Date.now();
    }
  }
  next();
});

setInterval(() => {
  const now = Date.now();
  for (const [channel, info] of streams.entries()) {
    if (info.activeTime && now - info.activeTime > 60000) {
      // 超过60秒无人访问
      console.log(`⏹ No viewers for ${channel}, stopping...`);
      info.process.kill('SIGKILL');
      // 清理生成的文件
      fs.readdirSync(STREAM_DIR)
        .filter((f) => f.startsWith(channel))
        .forEach((f) => fs.unlinkSync(path.join(STREAM_DIR, f)));
      streams.delete(channel);
    }
  }
}, 10000);

// 在主进程退出或收到信号时，确保清理所有子进程和临时文件
function cleanupAndExit(code = 0) {
  for (const [channel, info] of streams.entries()) {
    try {
      info.process.kill('SIGKILL');
    } catch (e) {
      // ignore
    }
    try {
      fs.readdirSync(STREAM_DIR)
        .filter((f) => f.startsWith(channel))
        .forEach((f) => fs.unlinkSync(path.join(STREAM_DIR, f)));
    } catch (e) {
      // ignore
    }
    streams.delete(channel);
  }
  // give a moment (可选)，然后退出
  setTimeout(() => process.exit(code), 50);
}

process.on('exit', () => cleanupAndExit(0));
process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  cleanupAndExit(1);
});

app.listen(PORT, () => {
  console.log(`📺 IPTV Server Streamer running at http://localhost:${PORT}`);
});
