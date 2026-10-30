package com.measured.player;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;

/**
 * Turns containers the WebView cannot play (AIFF, WMA, ALAC, CAF, MKA, AC3…) into
 * plain 16-bit PCM WAV using only framework codecs. The output is cached in
 * filesDir/transcode, so a track is converted once.
 *
 * The phone's own decoders are the limit here: ffmpeg on the desktop reads far more.
 * When MediaExtractor cannot even parse the container this returns null and the page
 * says so instead of failing silently.
 */
final class Transcode {

    private Transcode() {}

    static File cacheDir(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "transcode");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    static String keyFor(String name) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] d = md.digest(name.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", d[i]));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(name.hashCode());
        }
    }

    /** @return file:// URL of the cached WAV, or null when the format cannot be decoded. */
    static String prepare(Context ctx, String assetName, File plain) {
        String tag = assetName != null ? "a:" + assetName : "f:" + (plain != null ? plain.getName() : "?");
        File out = new File(cacheDir(ctx), keyFor(tag) + ".wav");
        if (out.exists() && out.length() > 4096) return "file://" + out.getAbsolutePath();

        MediaExtractor ex = new MediaExtractor();
        AssetFileDescriptor afd = null;
        try {
            if (assetName != null) {
                afd = ctx.getAssets().openFd(assetName);
                ex.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            } else if (plain != null) {
                ex.setDataSource(plain.getAbsolutePath());
            } else return null;

            int track = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) { track = i; fmt = f; break; }
            }
            if (track < 0 || fmt == null) return null;

            String mime = fmt.getString(MediaFormat.KEY_MIME);
            ex.selectTrack(track);

            MediaCodec codec = MediaCodec.createDecoderByType(mime);
            codec.configure(fmt, null, null, 0);
            codec.start();

            File tmp = new File(cacheDir(ctx), out.getName() + ".part");
            FileOutputStream fos = new FileOutputStream(tmp);
            fos.write(new byte[44]);                       // header patched at the end

            int rate = fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
            int chans = fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 2;
            long pcm = 0;

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inDone = false, outDone = false;
            while (!outDone) {
                if (!inDone) {
                    int inIx = codec.dequeueInputBuffer(10000);
                    if (inIx >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(inIx);
                        int n = ex.readSampleData(buf, 0);
                        if (n < 0) {
                            codec.queueInputBuffer(inIx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            codec.queueInputBuffer(inIx, 0, n, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int outIx = codec.dequeueOutputBuffer(info, 10000);
                if (outIx >= 0) {
                    ByteBuffer buf = codec.getOutputBuffer(outIx);
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset);
                        buf.limit(info.offset + info.size);
                        byte[] chunk = new byte[info.size];
                        buf.get(chunk);
                        fos.write(chunk);
                        pcm += info.size;
                    }
                    codec.releaseOutputBuffer(outIx, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                } else if (outIx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) chans = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                }
            }

            codec.stop();
            codec.release();
            fos.close();

            if (pcm <= 0) { tmp.delete(); return null; }

            patchHeader(tmp, rate, chans, pcm);
            if (!tmp.renameTo(out)) { tmp.delete(); return null; }
            return "file://" + out.getAbsolutePath();
        } catch (Exception e) {
            return null;
        } finally {
            ex.release();
            try { if (afd != null) afd.close(); } catch (IOException ignored) { }
        }
    }

    private static void patchHeader(File file, int rate, int chans, long pcmBytes) throws IOException {
        int byteRate = rate * chans * 2;
        RandomAccessFile raf = new RandomAccessFile(file, "rw");
        ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes("US-ASCII"));
        h.putInt((int) (36 + pcmBytes));
        h.put("WAVE".getBytes("US-ASCII"));
        h.put("fmt ".getBytes("US-ASCII"));
        h.putInt(16);                       // PCM chunk size
        h.putShort((short) 1);              // PCM
        h.putShort((short) chans);
        h.putInt(rate);
        h.putInt(byteRate);
        h.putShort((short) (chans * 2));    // block align
        h.putShort((short) 16);             // bits per sample
        h.put("data".getBytes("US-ASCII"));
        h.putInt((int) pcmBytes);
        raf.seek(0);
        raf.write(h.array());
        raf.close();
    }
}
