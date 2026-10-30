package com.measured.player;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.StatFs;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * MEASURED — offline local player shell.
 *
 * Everything ships inside the APK: the UI lives in assets/player, the default
 * library in assets/songs. Songs the user adds are copied into filesDir/songs.
 * The page is loaded from file:/// so playback needs no network stack at all —
 * the app has no INTERNET permission.
 */
public class MainActivity extends Activity {

    private static final String PAGE = "file:///android_asset/player/index.html";
    private static final int REQ_PICK = 4711;
    static final String ACTION_OPEN_CARD = "com.measured.player.OPEN_CARD";
    private boolean wantCard = false;
    /* Native decoders plus the containers Transcode can convert with MediaCodec. */
    private static final String AUDIO_EXT =
        "mp3 m4a mp4 m4b aac flac ogg oga opus wav wave weba webm"
        + " aiff aif aifc caf wma ape alac mka wv tta amr ac3 dts dsf dff spx au snd";

    private WebView web;
    private SharedPreferences prefs;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("measured", MODE_PRIVATE);
        final boolean dark0 = "dark".equals(prefs.getString("theme", "light"));

        getWindow().setBackgroundDrawableResource(dark0 ? R.color.ink : R.color.paper);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(dark0 ? "#131210" : "#e8e4db"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        android.webkit.WebView.setWebContentsDebuggingEnabled(true); // TEMP: lets adb-forwarded CDP drive the page
    web.addJavascriptInterface(new Bridge(), "AndroidBridge");


        // Transport buttons from the notification, headset and Bluetooth route back
        // into the page, so the system player and the deck never drift apart.
        MediaService.sink = new MediaService.Sink() {
            @Override public void exec(final String cmd, final long arg) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        web.evaluateJavascript("(window.PlayerAPI&&PlayerAPI.mediaCommand)?PlayerAPI.mediaCommand("
                                + JSONObject.quote(cmd) + "," + arg + "):0", null);
                    }
                });
            }
        };
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 991);
        }
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return false;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (wantCard) openCard();
            }
        });

        wantCard = ACTION_OPEN_CARD.equals(getIntent() == null ? null : getIntent().getAction());
        // Warm NewPipeExtractor while the page is still loading: the first stream
        // resolve otherwise pays the whole signature/player handshake on the tap
        // (measured at 30.7 s cold vs ~1 s warm).
        Yt.warm();
        web.loadUrl(PAGE);
        applyStatusBar(dark0);
    }

    /** Show our now-playing card (called when the media card in the shade is tapped). */
    private void openCard() {
        wantCard = false;
        if (web == null) return;
        web.post(new Runnable() {
            @Override public void run() {
                web.evaluateJavascript("(window.PlayerAPI&&PlayerAPI.openCard)?PlayerAPI.openCard():0", null);
            }
        });
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && ACTION_OPEN_CARD.equals(intent.getAction())) openCard();
    }

    private void applyStatusBar(boolean dark) {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 21) {
            w.setStatusBarColor(Color.parseColor(dark ? "#141310" : "#e8e4db"));
            w.setNavigationBarColor(Color.parseColor(dark ? "#141310" : "#e8e4db"));
        }
        if (Build.VERSION.SDK_INT >= 23) {
            View d = w.getDecorView();
            int flags = d.getSystemUiVisibility();
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            d.setSystemUiVisibility(flags);
        }
    }

    private File addedDir() {
        File d = new File(getFilesDir(), "songs");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    // ── the JS bridge ────────────────────────────────────────────────────────
    public class Bridge {

        /** Bundled library (from library.json made at package time) + user-added files. */
        @JavascriptInterface
        public String library() {
            JSONObject out = new JSONObject();
            try {
                String baked = readAsset("player/library.json");
                out.put("bundled", baked.isEmpty() ? new JSONArray() : new JSONArray(baked));
                JSONArray added = new JSONArray();
                File[] files = addedDir().listFiles();
                if (files != null) {
                    for (File f : files) {
                        if (!f.isFile() || !isAudio(f.getName())) continue;
                        JSONObject o = new JSONObject();
                        o.put("file", f.getName());
                        o.put("bytes", f.length());
                        o.put("dur", durationOf(f));
                        o.put("mtime", f.lastModified());
                        o.put("url", Uri.fromFile(f).toString());
                        added.put(o);
                    }
                }
                out.put("added", added);
            } catch (Exception e) {
                out.optString("bundled");
            }
            return out.toString();
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        /** Opens the system file picker so the user can import songs from Downloads etc. */
        @JavascriptInterface
        public void pickSongs() {
            runOnUiThread(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    /* filesystem-wide, not audio-filtered: some ROMs classify wma/ape/aiff
                       as application/octet-stream and would hide them behind "audio/*" */
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "audio/*", "application/octet-stream" });
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    try {
                        startActivityForResult(i, REQ_PICK);
                    } catch (Exception e) {
                        toast("No file picker on this device");
                    }
                }
            });
        }

        /** Converts a container the WebView cannot decode into a cached WAV.
            @return file:// URL, or null when this phone cannot read the format. */
        @JavascriptInterface
        public String prepare(String src, String name) {
            try {
                String clean = safeName(name);
                if ("add".equals(src)) {
                    File f = new File(addedDir(), clean);
                    String r = f.isFile() ? Transcode.prepare(MainActivity.this, null, f) : "NOFILE " + f.getAbsolutePath();
                    return r != null && r.startsWith("file:") ? r : null;
                }
                return Transcode.prepare(MainActivity.this, "songs/" + clean, null);
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public String removeAdded(String name) {
            File f = new File(addedDir(), safeName(name));
            boolean ok = f.isFile() && f.delete();
            return "{\"ok\":" + ok + "}";
        }

        @JavascriptInterface
        public String clearAdded() {
            int n = 0;
            File[] files = addedDir().listFiles();
            if (files != null) for (File f : files) if (f.isFile() && f.delete()) n++;
            return "{\"removed\":" + n + "}";
        }

        @JavascriptInterface
        public String storage() {
            JSONObject o = new JSONObject();
            try {
                long used = 0; int count = 0;
                File[] files = addedDir().listFiles();
                if (files != null) for (File f : files) if (f.isFile()) { used += f.length(); count++; }
                StatFs fs = new StatFs(getFilesDir().getAbsolutePath());
                o.put("addedBytes", used);
                o.put("addedCount", count);
                o.put("freeBytes", fs.getAvailableBytes());
                o.put("totalBytes", fs.getTotalBytes());
            } catch (Exception e) { /* zeros are fine */ }
            return o.toString();
        }

        @JavascriptInterface
        public String get(String key) { return prefs.getString(key, ""); }

        @JavascriptInterface
        public void set(String key, String value) { prefs.edit().putString(key, value).apply(); }

        /** keeps the system bars in step with the in-app theme */
        @JavascriptInterface
        public void setTheme(String mode) {
            final boolean dark = "dark".equals(mode);
            prefs.edit().putString("theme", dark ? "dark" : "light").apply();
            runOnUiThread(new Runnable() {
                public void run() {
                    web.setBackgroundColor(Color.parseColor(dark ? "#131210" : "#e8e4db"));
                    applyStatusBar(dark);
                }
            });
        }

        /** Page pushes "now playing" so Android can show its own player card. */
        @JavascriptInterface
        public void media(String json) { MediaService.push(MainActivity.this, json); }

    // ── YouTube (NewPipeExtractor, on-device) ────────────────────────────────
    // Each job answers later through PlayerAPI.ytDone(token, ok, payload).
    @JavascriptInterface
    public void ytSearch(String q, String limit, String token) {
      int max = 24;
      try { max = Math.max(1, Math.min(40, Integer.parseInt(limit))); } catch (Exception ignored) { }
      Yt.search(MainActivity.this.web, q == null ? "" : q, max, token);
    }

    @JavascriptInterface
    public void ytAudio(String id, String token) {
      Yt.audio(MainActivity.this.web, id == null ? "" : id, token);
    }

    @JavascriptInterface
    public void ytDownload(String json, String token) {
      try {
        JSONObject o = new JSONObject(json == null ? "{}" : json);
        Yt.download(MainActivity.this, MainActivity.this.web,
            o.optString("id"), o.optString("title"), o.optString("author"), token);
      } catch (Exception e) {
        Yt.fail(MainActivity.this.web, token, "bad request: " + e.getMessage());
      }
    }


        public String version() { return "1.0.0"; }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK || res != RESULT_OK || data == null) return;

        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                uris.add(data.getClipData().getItemAt(i).getUri());
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        int copied = 0;
        for (Uri u : uris) {
            try {
                if (copyIn(u)) copied++;
            } catch (Exception e) { /* skip this file, keep the rest */ }
        }
        final int n = copied;
        runOnUiThread(new Runnable() {
            public void run() {
                toast(n == 0 ? "Nothing imported" : n + " song" + (n == 1 ? "" : "s") + " added");
                web.evaluateJavascript(
                    "(window.PlayerAPI && PlayerAPI.onSongsChanged ? PlayerAPI.onSongsChanged() : 0)", null);
            }
        });
    }

    private boolean copyIn(Uri uri) throws Exception {
        String name = null;
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        name = safeName(name);
        if (!isAudio(name)) {
            // give unknown types a sensible extension from the mime type
            String mime = getContentResolver().getType(uri);
            if (mime != null) {
                if (mime.contains("mpeg")) name += ".mp3";
                else if (mime.contains("webm")) name += ".webm";
                else if (mime.contains("mp4") || mime.contains("m4a")) name += ".m4a";
                else if (mime.contains("ogg") || mime.contains("opus")) name += ".ogg";
                else if (mime.contains("flac")) name += ".flac";
                else if (mime.contains("wav") || mime.contains("x-wav")) name += ".wav";
                else if (mime.contains("aiff") || mime.contains("aif")) name += ".aiff";
                else if (mime.contains("wma") || mime.contains("ms-wma")) name += ".wma";
                else if (mime.contains("ape")) name += ".ape";
                else if (mime.contains("alac")) name += ".alac";
                else if (mime.contains("matroska") || mime.contains("mka")) name += ".mka";
                else if (mime.contains("ac3")) name += ".ac3";
                else if (mime.contains("dts")) name += ".dts";
                else if (mime.contains("caf")) name += ".caf";
            }
            if (!isAudio(name)) return false;
        }

        File out = uniqueFile(addedDir(), name);
        try (InputStream in = getContentResolver().openInputStream(uri);
             FileOutputStream fo = new FileOutputStream(out)) {
            if (in == null) return false;
            byte[] buf = new byte[1 << 16];
            int r;
            while ((r = in.read(buf)) > 0) fo.write(buf, 0, r);
        }
        return out.length() > 1024;
    }

    static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        String base = name, ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) { base = name.substring(0, dot); ext = name.substring(dot); }
        for (int i = 2; i < 999; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return f;
    }

    static String safeName(String name) {
        if (name == null) return "track";
        String n = name.replace('\\', '/');
        int slash = n.lastIndexOf('/');
        if (slash >= 0) n = n.substring(slash + 1);
        n = n.replaceAll("[\\x00-\\x1f:*?\"<>|]", "_").trim();
        return n.isEmpty() ? "track" : n;
    }

    private static boolean isAudio(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        String ext = name.substring(dot + 1).toLowerCase(Locale.US);
        return (" " + AUDIO_EXT + " ").contains(" " + ext + " ");
    }

    private static long durationOf(File f) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(f.getAbsolutePath());
            String d = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            return d == null ? 0 : Long.parseLong(d) / 1000;
        } catch (Exception e) {
            return 0;
        } finally {
            try { r.release(); } catch (Exception ignored) { }
        }
    }

    private String readAsset(String path) {
        try (InputStream in = getAssets().open(path)) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) > 0) bo.write(buf, 0, r);
            return bo.toString("UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        MediaService.sink = null;
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
    @Override
    protected void onResume() {
        super.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
    }
}
