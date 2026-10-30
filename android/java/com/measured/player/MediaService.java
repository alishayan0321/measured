package com.measured.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;

/**
 * Keeps Android's own player in sync with the WebView: a MediaSession (so the
 * lock screen, the shade player card, the volume panel, Bluetooth and headset
 * buttons all work) plus a MediaStyle notification, which is what earns the app
 * the foreground-service status it needs to keep playing in the background.
 */
public class MediaService extends Service {

    static final String CHANNEL = "measured-playback";
    static final int NOTIF_ID = 4211;
    static final String A_UPDATE = "com.measured.player.UPDATE";
    static final String A_CMD = "com.measured.player.CMD";

    /** MainActivity installs this so transport buttons reach the page. */
    interface Sink { void exec(String cmd, long arg); }
    static Sink sink;

    private MediaSession session;
    private String title = "";
    private String artist = "";
    private boolean playing = false;
    private long pos = 0;
    private long dur = 0;
    private String artKey = "";
    private Bitmap art = null;

    static void push(Context ctx, String json) {
        Intent i = new Intent(ctx, MediaService.class).setAction(A_UPDATE).putExtra("json", json);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    @Override public void onCreate() {
        super.onCreate();
        makeChannel();
        session = new MediaSession(this, "MEASURED");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { cmd("play", 0); }
            @Override public void onPause() { cmd("pause", 0); }
            @Override public void onSkipToNext() { cmd("next", 0); }
            @Override public void onSkipToPrevious() { cmd("prev", 0); }
            @Override public void onSeekTo(long p) { cmd("seek", p); }
            @Override public void onStop() { cmd("pause", 0); }
        });
        // Tapping the media card opens the app straight into our now-playing card.
        Intent open = new Intent(this, MainActivity.class)
                .setAction(MainActivity.ACTION_OPEN_CARD)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session.setSessionActivity(openPi);
        session.setActive(true);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (A_CMD.equals(action)) {
            cmd(intent.getStringExtra("cmd"), intent.getLongExtra("arg", 0));
            return START_NOT_STICKY;
        }
        try {
            JSONObject j = new JSONObject(intent.getStringExtra("json"));
            title = j.optString("title", "");
            artist = j.optString("artist", "");
            playing = j.optBoolean("playing", false);
            pos = j.optLong("pos", 0);
            dur = j.optLong("dur", 0);
            String a = j.optString("art", "");
            if (!a.equals(artKey)) { artKey = a; art = decodeArt(a); }
            publish();
            startForeground(NOTIF_ID, build());
        } catch (Throwable ignored) { /* a bad payload must not kill playback */ }
        return START_NOT_STICKY;
    }

    private void cmd(String c, long arg) {
        if (c == null) return;
        // optimistic local flip so the card reacts instantly, the page re-syncs after
        if ("play".equals(c)) playing = true;
        else if ("pause".equals(c)) playing = false;
        try { publish(); startForeground(NOTIF_ID, build()); } catch (Throwable ignored) { }
        if (sink != null) sink.exec(c, arg);
    }

    private void publish() {
        try {
            MediaMetadata.Builder m = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, dur);
            if (art != null) m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
            session.setMetadata(m.build());

            long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
                    | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO
                    | PlaybackState.ACTION_STOP;
            session.setPlaybackState(new PlaybackState.Builder()
                    .setActions(actions)
                    .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                            pos, playing ? 1f : 0f)
                    .build());
        } catch (Throwable ignored) { }
    }

    private PendingIntent act(String cmd, long arg) {
        Intent i = new Intent(this, MediaService.class).setAction(A_CMD)
                .putExtra("cmd", cmd).putExtra("arg", arg);
        int f = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        return PendingIntent.getService(this, cmd.hashCode(), i, f | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent open() {
        Intent i = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        int f = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        return PendingIntent.getActivity(this, 0, i, f | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification build() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_note)
                .setContentTitle(title.isEmpty() ? "MEASURED" : title)
                .setContentText(artist)
                .setContentIntent(open())
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setOngoing(playing)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_previous, "Previous", act("prev", 0)).build())
                .addAction(new Notification.Action.Builder(
                        playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Play", playing ? act("pause", 0) : act("play", 0)).build())
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_next, "Next", act("next", 0)).build());
        if (art != null) b.setLargeIcon(art);
        b.setColor(0xFFDC3F19);
        b.setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private void makeChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Playback",
                NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Now playing");
        ch.setShowBadge(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }

    /** Cover art: bundled files live in the APK assets, imported ones on disk. */
    private Bitmap decodeArt(String path) {
        if (path == null || path.isEmpty()) return null;
        final String ASSET = "file:///android_asset/";
        try {
            InputStream in;
            if (path.startsWith(ASSET)) in = getAssets().open(path.substring(ASSET.length()));
            else if (path.startsWith("file://")) in = new FileInputStream(new File(android.net.Uri.parse(path).getPath()));
            else in = new FileInputStream(new File(path));
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeStream(in, null, o);
            in.close();
            int scale = 1;
            while (o.outWidth / scale > 640) scale *= 2;
            BitmapFactory.Options d = new BitmapFactory.Options();
            d.inSampleSize = scale;
            in = path.startsWith(ASSET) ? getAssets().open(path.substring(ASSET.length()))
                    : new FileInputStream(new File(android.net.Uri.parse(path).getPath()));
            Bitmap bm = BitmapFactory.decodeStream(in, null, d);
            in.close();
            return bm;
        } catch (Throwable t) {
            return null;
        }
    }

    @Override public void onDestroy() {
        try {
            if (session != null) {
                session.setActive(false);
                session.release();
            }
        } catch (Throwable ignored) { }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
