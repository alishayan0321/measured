package com.measured.player;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.search.SearchExtractor;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.DeliveryMethod;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;
import org.schabi.newpipe.extractor.stream.VideoStream;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * YouTube on the phone, without yt-dlp.
 *
 * NewPipeExtractor does the signature/PO-token work the plain InnerTube API no
 * longer allows, so we can hand the page a playable googlevideo URL and save the
 * audio into the added-songs folder — the same behaviour the desktop build gets
 * from yt-dlp.
 *
 * Everything is async: the page calls a method with a token, we hop to a worker
 * thread, then push the answer back through PlayerAPI.ytDone(token, ok, json).
 */
final class Yt {

    private static final ExecutorService POOL = Executors.newFixedThreadPool(2);
    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static volatile boolean ready = false;

    private Yt() {}

    private static synchronized void init() {
        if (ready) return;
        NewPipe.init(new Net(), new Localization("en", "US"));
        ready = true;
    }

    static void search(final WebView web, final String query, final int limit, final String token) {
        POOL.execute(new Runnable() {
            public void run() {
                try {
                    init();
                    SearchExtractor se = ServiceList.YouTube.getSearchExtractor(query);
                    se.fetchPage();
                    JSONArray out = new JSONArray();
                    List<InfoItem> items = se.getInitialPage().getItems();
                    for (InfoItem it : items) {
                        if (!(it instanceof StreamInfoItem)) continue;
                        StreamInfoItem s = (StreamInfoItem) it;
                        String id = videoIdOf(s.getUrl());
                        if (id == null) continue;
                        JSONObject o = new JSONObject();
                        o.put("id", id);
                        o.put("title", s.getName() == null ? "" : s.getName());
                        o.put("author", s.getUploaderName() == null ? "" : s.getUploaderName());
                        o.put("seconds", s.getDuration() > 0 ? s.getDuration() : 0);
                        o.put("views", 0);
                        String thumb = null;
                        if (s.getThumbnails() != null && !s.getThumbnails().isEmpty()) {
                            thumb = s.getThumbnails().get(s.getThumbnails().size() - 1).getUrl();
                        }
                        o.put("thumb", thumb == null ? "" : thumb);
                        out.put(o);
                        if (out.length() >= limit) break;
                    }
                    done(web, token, true, out.toString());
                } catch (Throwable t) {
                    done(web, token, false, msg(t));
                }
            }
        });
    }

    /** Resolve a playable URL + metadata for one video id. */
    static void audio(final WebView web, final String id, final String token) {
        POOL.execute(new Runnable() {
            public void run() {
                try {
                    init();
                    StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, watchUrl(id));
                    String url = null;
                    String mime = "audio/webm";
                    long kbps = 0;
                    AudioStream best = pickAudio(info.getAudioStreams());
                    if (best != null) {
                        url = best.getUrl();
                        mime = best.getFormat() == null ? mime : best.getFormat().getMimeType();
                        kbps = best.getAverageBitrate();
                    }
                    if (url == null && info.getVideoStreams() != null) {
                        for (VideoStream v : info.getVideoStreams()) {
                            if (v.getUrl() != null && v.isVideoOnly() == false) {
                                url = v.getUrl();
                                mime = v.getFormat() == null ? "video/mp4" : v.getFormat().getMimeType();
                                break;
                            }
                        }
                    }
                    if (url == null) {
                        done(web, token, false, "no playable stream for this video");
                        return;
                    }
                    JSONObject o = new JSONObject();
                    o.put("url", url);
                    o.put("mime", mime);
                    o.put("kbps", kbps);
                    o.put("title", info.getName() == null ? "" : info.getName());
                    o.put("author", info.getUploaderName() == null ? "" : info.getUploaderName());
                    o.put("seconds", info.getDuration() > 0 ? info.getDuration() : 0);
                    done(web, token, true, o.toString());
                } catch (Throwable t) {
                    done(web, token, false, msg(t));
                }
            }
        });
    }

    /** Save the audio of one video into the added-songs folder. */
    static void download(final Context ctx, final WebView web, final String id,
                         final String title, final String author, final String token) {
        POOL.execute(new Runnable() {
            public void run() {
                try {
                    init();
                    StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, watchUrl(id));
                    String url = null;
                    String ext = "webm";
                    AudioStream best = pickAudio(info.getAudioStreams());
                    if (best != null) {
                        url = best.getUrl();
                        String m = best.getFormat() == null ? "" : best.getFormat().getMimeType();
                        ext = m.contains("mp4") || m.contains("m4a") ? "m4a" : "webm";
                    }
                    if (url == null) {
                        done(web, token, false, "no audio stream to save");
                        return;
                    }
                    File dir = new File(ctx.getFilesDir(), "songs");
                    if (!dir.exists() && !dir.mkdirs()) {
                        done(web, token, false, "cannot create songs folder");
                        return;
                    }
                    String stem = MainActivity.safeName(author + " - " + title);
                    if (stem.length() > 80) stem = stem.substring(0, 80).trim();
                    if (stem.isEmpty()) stem = "YouTube " + id;
                    File out = MainActivity.uniqueFile(dir, stem + "." + ext);
                    /* Write beside the target and rename at the end: a half-written
                       take must never be visible as a library entry, because the
                       scan would list it and the decoder would then fail on it. */
                    File part = new File(dir, out.getName() + ".part");

                    try {
                        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36");
                        c.setConnectTimeout(20000);
                        c.setReadTimeout(30000);
                        c.connect();
                        if (c.getResponseCode() / 100 != 2) {
                            c.disconnect();
                            done(web, token, false, "download failed: HTTP " + c.getResponseCode());
                            return;
                        }
                        long wrote = 0;
                        InputStream in = null;
                        FileOutputStream fos = null;
                        try {
                            in = c.getInputStream();
                            fos = new FileOutputStream(part);
                            byte[] buf = new byte[65536];
                            int n;
                            while ((n = in.read(buf)) > 0) {
                                fos.write(buf, 0, n);
                                wrote += n;
                            }
                            fos.flush();
                        } finally {
                            if (fos != null) try { fos.close(); } catch (IOException ignored) { }
                            if (in != null) try { in.close(); } catch (IOException ignored) { }
                            c.disconnect();
                        }
                        if (wrote < 20000) {
                            part.delete();
                            done(web, token, false, "download too small (" + wrote + " bytes)");
                            return;
                        }
                        if (!part.renameTo(out)) {
                            part.delete();
                            done(web, token, false, "cannot save the file");
                            return;
                        }
                        done(web, token, true, out.getName());
                    } catch (Throwable t) {
                        part.delete();
                        done(web, token, false, msg(t));
                    }
                } catch (Throwable t) {
                    done(web, token, false, msg(t));
                }
            }
        });
    }

    /**
     * Best audio-only track. WebM/Opus is preferred because this WebView plays it
     * reliably while m4a/AAC occasionally fails with MEDIA_ELEMENT_ERROR; within a
     * container the highest average bitrate wins, so this is YouTube's best audio
     * rather than the 360p muxed track.
     */
    private static AudioStream pickAudio(List<AudioStream> audios) {
        AudioStream best = null;
        long bestScore = -1;
        for (AudioStream a : audios) {
            if (a == null || a.getUrl() == null) continue;
            String m = a.getFormat() == null ? "" : a.getFormat().getMimeType();
            boolean webm = m.contains("webm") || m.contains("opus");
            long score = a.getAverageBitrate() + (webm ? 10000L : 0L);
            if (score > bestScore) { bestScore = score; best = a; }
        }
        return best;
    }

    /** Fetch the player JS in the background so the first tap is not a 30 s wait. */
    static void warm() {
        POOL.execute(new Runnable() {
            public void run() {
                try {
                    init();
                    // yt-dlp's canonical test video: small, always available
                    StreamInfo.getInfo(ServiceList.YouTube, watchUrl("BaW_jenozKc"));
                } catch (Throwable ignored) { }
            }
        });
    }

    static void fail(WebView web, String token, String message) { done(web, token, false, message); }

    // ── helpers ────────────────────────────────────────────────────────────────

    private static void done(final WebView web, final String token, final boolean ok, final String payload) {
        final String js = "(window.PlayerAPI&&PlayerAPI.ytDone)?PlayerAPI.ytDone("
                + JSONObject.quote(token) + "," + ok + "," + JSONObject.quote(payload == null ? "" : payload) + "):0";
        UI.post(new Runnable() {
            public void run() {
                if (web != null) web.evaluateJavascript(js, null);
            }
        });
    }

    private static String watchUrl(String id) {
        return "https://www.youtube.com/watch?v=" + id;
    }

    private static String videoIdOf(String url) {
        if (url == null) return null;
        int i = url.indexOf("v=");
        if (i < 0) return null;
        String id = url.substring(i + 2);
        int amp = id.indexOf('&');
        if (amp > 0) id = id.substring(0, amp);
        return id.length() == 11 ? id : null;
    }

    private static String msg(Throwable t) {
        String m = t.getClass().getSimpleName() + ": " + (t.getMessage() == null ? "" : t.getMessage());
        return m.length() > 220 ? m.substring(0, 220) : m;
    }

    /** Minimal HttpURLConnection downloader — NewPipeExtractor only needs GET/POST. */
    private static final class Net extends Downloader {
        @Override
        public Response execute(Request request) throws IOException, ReCaptchaException {
            HttpURLConnection conn = (HttpURLConnection) new URL(request.url()).openConnection();
            conn.setRequestMethod(request.httpMethod());
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36");
            conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
            for (Map.Entry<String, List<String>> h : request.headers().entrySet()) {
                for (String v : h.getValue()) {
                    conn.setRequestProperty(h.getKey(), v);
                }
            }
            byte[] data = request.dataToSend();
            if (data != null && data.length > 0) {
                conn.setDoOutput(true);
                java.io.OutputStream os = conn.getOutputStream();
                os.write(data);
                os.flush();
                os.close();
            }
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) body.write(buf, 0, n);
                in.close();
            }
            conn.disconnect();
            /* Decode once, after the last byte is in. Decoding each 16 KB chunk on
               its own splits any multi-byte character that straddles the boundary
               and turns both halves into U+FFFD, which corrupts the JSON body. */
            return new Response(code, conn.getResponseMessage(), conn.getHeaderFields(),
                    body.toString("UTF-8"), request.url());
        }
    }
}
