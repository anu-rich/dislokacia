package app.stalia.laytime;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;

/**
 * What the page cannot do from inside a web view:
 *  - hand a file it has made (a Word or Excel export) to the phone's share sheet;
 *  - send a link through the same sheet;
 *  - learn which link the app was opened with ("stalia://c/…" — a calculation somebody shared).
 */
@CapacitorPlugin(name = "StaliaShare")
public class StaliaSharePlugin extends Plugin {

    private String launchUrl;

    @Override
    public void load() {
        launchUrl = linkOf(getActivity().getIntent());
    }

    /** A link that arrives while the app is already open. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String url = linkOf(intent);
        if (url == null) return;
        JSObject data = new JSObject();
        data.put("url", url);
        getBridge().triggerWindowJSEvent("staliaLink", data.toString());
    }

    private static String linkOf(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        Uri uri = intent.getData();
        return uri == null ? null : uri.toString();
    }

    /** The link the app was started with, told once. */
    @PluginMethod
    public void launchUrl(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("url", launchUrl == null ? "" : launchUrl);
        launchUrl = null;
        call.resolve(ret);
    }

    @PluginMethod
    public void text(PluginCall call) {
        String text = call.getString("text", "");
        String title = call.getString("title", "");
        if (text == null || text.isEmpty()) {
            call.reject("Nothing to share");
            return;
        }
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
            getActivity().startActivity(Intent.createChooser(send, null));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open the share sheet", e);
        }
    }

    @PluginMethod
    public void file(PluginCall call) {
        String name = call.getString("name", "stalia");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        if (data == null || data.isEmpty()) {
            call.reject("Nothing to share");
            return;
        }
        try {
            // only a plain file name ever reaches the disk
            String safe = (name == null ? "stalia" : name).replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-");
            if (safe.isEmpty() || safe.startsWith(".")) safe = "stalia" + safe;
            File dir = new File(getContext().getCacheDir(), "exports");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("no room for the file");
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete(); // files of earlier exports are not kept
            File file = new File(dir, safe);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, safe);
            send.setClipData(ClipData.newRawUri(safe, uri)); // lets the sheet preview the file and the receiver read it
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(send, null));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not share the file", e);
        }
    }
}
