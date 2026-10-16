package com.pianosmith.app;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

/**
 * Receives ACTION_SEND shares (YouTube, Spotify, browsers, …) and forwards the
 * text/URL into the WebView as a {@code pianosmithShare} event.
 */
public class MainActivity extends BridgeActivity {
  private String pendingShareText;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private int deliverAttempts;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    captureShare(getIntent());
    scheduleDeliverShare();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    captureShare(intent);
    scheduleDeliverShare();
  }

  private void captureShare(Intent intent) {
    if (intent == null) return;
    if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
    String type = intent.getType();
    if (type == null || !type.startsWith("text/")) return;
    String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
    if (shared == null) return;
    shared = shared.trim();
    if (shared.isEmpty()) return;
    pendingShareText = shared;
    intent.removeExtra(Intent.EXTRA_TEXT);
  }

  private void scheduleDeliverShare() {
    if (pendingShareText == null) return;
    deliverAttempts = 0;
    handler.post(this::tryDeliverShare);
  }

  private void tryDeliverShare() {
    if (pendingShareText == null) return;
    if (getBridge() == null || getBridge().getWebView() == null) {
      retryDeliver();
      return;
    }
    try {
      JSONObject detail = new JSONObject();
      detail.put("text", pendingShareText);
      String payload = detail.toString();
      String js =
          "(function(){var d="
              + payload
              + ";window.__pianosmithShare=d;"
              + "window.dispatchEvent(new CustomEvent('pianosmithShare',{detail:d}));})();";
      getBridge()
          .eval(
              js,
              value -> {
                pendingShareText = null;
              });
    } catch (Exception error) {
      retryDeliver();
    }
  }

  private void retryDeliver() {
    if (deliverAttempts++ < 50) {
      handler.postDelayed(this::tryDeliverShare, 100);
    }
  }
}
