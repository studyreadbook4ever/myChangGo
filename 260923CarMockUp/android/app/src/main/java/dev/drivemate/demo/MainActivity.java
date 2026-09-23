package dev.drivemate.demo;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.util.Collections;

/** Offline presentation shell. All product behavior remains in the React mockup. */
public final class MainActivity extends Activity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + ASSET_HOST + "/index.html";
    private WebView webView;
    private boolean navigationActive;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Keep a presentation visible even when the phone's sleep timer is short.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        createWebView(savedInstanceState);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView(Bundle savedInstanceState) {
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(Color.rgb(248, 249, 245));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            container.setOnApplyWindowInsetsListener((view, windowInsets) -> {
                Insets bars = windowInsets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            container.setFitsSystemWindows(true);
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(248, 249, 245));
        container.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(container);
        container.requestApplyInsets();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setGeolocationEnabled(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setTextZoom(100);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        webView.setWebChromeClient(new WebChromeClient());
        // The only native bridge is a boolean presentation setting. External pages,
        // frames and requests cannot load; file/content access stays disabled.
        webView.addJavascriptInterface(new NavigationBridge(), "DriveMateNative");
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                // A reloaded page starts on the dashboard, never with stale hidden bars.
                navigationActive = false;
                applyNavigationMode();
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (isLocalAsset(request.getUrl())) {
                    WebResourceResponse response = assetLoader.shouldInterceptRequest(request.getUrl());
                    if (response != null) return response;
                }
                // Do not fall through to a network fetch for a typo or external URL.
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                        Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isLocalAsset(request.getUrl());
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                navigationActive = false;
                applyNavigationMode();
                ((ViewGroup) view.getParent()).removeView(view);
                view.destroy();
                webView = null;
                recreate();
                return true;
            }
        });

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }
    }

    private boolean isLocalAsset(Uri uri) {
        return "https".equals(uri.getScheme()) && ASSET_HOST.equals(uri.getHost());
    }

    /** Called only by the app's bundled frontend; no privileged device APIs exposed. */
    public final class NavigationBridge {
        @JavascriptInterface
        public void setNavigationActive(boolean active) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || webView == null) return;
                String currentUrl = webView.getUrl();
                if (currentUrl == null || !isLocalAsset(Uri.parse(currentUrl))) return;
                navigationActive = active;
                applyNavigationMode();
            });
        }
    }

    @SuppressWarnings("deprecation")
    private void applyNavigationMode() {
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller == null) return;
            controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            if (navigationActive) controller.hide(WindowInsets.Type.systemBars());
            else controller.show(WindowInsets.Type.systemBars());
        } else {
            int immersiveFlags = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
            int currentFlags = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(navigationActive
                    ? currentFlags | immersiveFlags : currentFlags & ~immersiveFlags);
        }
        decor.requestApplyInsets();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyNavigationMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && navigationActive) applyNavigationMode();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView == null) {
            moveTaskToBack(true);
            return;
        }
        // Optional React callback closes its sheet or returns to the home tab first.
        webView.evaluateJavascript(
                "(function(){try{return typeof window.driveMateBack==='function'"
                        + " && window.driveMateBack()===true;}catch(e){return false;}})()",
                handled -> {
                    if ("true".equals(handled) || webView == null) return;
                    if (webView.canGoBack()) webView.goBack();
                    else moveTaskToBack(true);
                });
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        applyNavigationMode();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("DriveMateNative");
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
