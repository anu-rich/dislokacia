package app.stalia.laytime;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Prints the page shown in the app's web view through Android's print service.
 * The page's print stylesheet leaves only the laytime statement, so the system
 * dialog offers exactly that document — on paper or as "Save as PDF".
 */
@CapacitorPlugin(name = "StaliaPrint")
public class StaliaPrintPlugin extends Plugin {

    @PluginMethod
    public void print(final PluginCall call) {
        final String jobName = call.getString("name", "Stalia laytime statement");
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                WebView webView = getBridge().getWebView();
                if (manager == null || webView == null) {
                    call.reject("Printing is not available on this device");
                    return;
                }
                PrintAttributes attributes = new PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .build();
                manager.print(jobName, webView.createPrintDocumentAdapter(jobName), attributes);
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not start printing", e);
            }
        });
    }
}
