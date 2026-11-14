'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

type Mode = 'direct' | 'worker';

export default function StreamTestPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [mode, setMode] = useState<Mode>('worker');
  const [activeUrl, setActiveUrl] = useState('');
  const [status, setStatus] = useState('等待输入 M3U8 地址');

  const stop = () => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  };

  const play = () => {
    const video = videoRef.current;
    const original = sourceUrl.trim();
    if (!video || !original) {
      setStatus('请先输入完整的 M3U8 地址');
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(original);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    } catch {
      setStatus('地址无效：请输入 http:// 或 https:// 开头的完整 URL');
      return;
    }

    stop();
    const playbackUrl =
      mode === 'worker'
        ? `/api/stream-test?url=${encodeURIComponent(parsed.href)}`
        : parsed.href;

    setActiveUrl(playbackUrl);
    setStatus(mode === 'worker' ? '正在通过 Worker 原生流式转发加载…' : '正在直连上游加载…');

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        debug: false,
        xhrSetup: (xhr) => {
          // 同源 Worker 测试请求携带 LibreTV 登录 Cookie。
          if (mode === 'worker') xhr.withCredentials = true;
        },
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus(mode === 'worker' ? 'Worker 清单加载成功，开始播放' : '直连清单加载成功，开始播放');
        void video.play().catch(() => setStatus('清单已加载，请点击视频播放'));
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setStatus(`播放失败：${data.type} / ${data.details}`);
        }
      });
      hls.loadSource(playbackUrl);
      hls.attachMedia(video);
      return;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playbackUrl;
      video.onloadedmetadata = () => {
        setStatus('清单加载成功，请点击播放');
      };
      video.onerror = () => setStatus('播放失败：浏览器原生 HLS 加载错误');
      return;
    }

    setStatus('当前浏览器不支持 HLS 播放');
  };

  useEffect(() => () => {
    hlsRef.current?.destroy();
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-xl font-semibold">Worker 原生流式转发测试</h1>
        <p className="mt-1 text-sm text-muted">
          独立测试页，不修改正式播放器。使用同一条 M3U8 地址分别测试直连和 Worker 转发。
        </p>
      </header>

      <label className="flex flex-col gap-2 text-sm">
        M3U8 完整地址
        <textarea
          className="min-h-24 w-full rounded-lg border border-border bg-background p-3"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="粘贴 DevTools Network 中的 index.m3u8 / mixed.m3u8 完整请求地址"
          spellCheck={false}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="mode" checked={mode === 'direct'} onChange={() => setMode('direct')} />
          直连上游
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="mode" checked={mode === 'worker'} onChange={() => setMode('worker')} />
          Worker 流式转发
        </label>
        <button type="button" className="btn-primary" onClick={play}>开始测试</button>
        <button type="button" className="btn-ghost" onClick={() => { stop(); setStatus('已停止'); }}>停止</button>
      </div>

      <video
        ref={videoRef}
        controls
        playsInline
        className="aspect-video w-full rounded-lg bg-black"
      />

      <section className="rounded-lg border border-border p-3 text-sm">
        <p><strong>状态：</strong>{status}</p>
        <p className="mt-2 break-all text-muted">
          <strong>当前请求入口：</strong>{activeUrl || '尚未开始'}
        </p>
      </section>

      <p className="text-xs text-muted">
        建议固定同一视频、同一清晰度和相近时间段，分别播放数分钟；在浏览器 Network 中观察 TS 分片请求。
        Worker 模式下，分片请求应指向当前 LibreTV 域名，而不是直接指向上游媒体域名。
      </p>
    </main>
  );
}
