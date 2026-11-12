package app.stalia.laytime;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StaliaPrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
