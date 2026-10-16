package com.agentharness.mobile;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class MainActivity extends Activity {
    private static final String LOCAL_HOST = "appassets.androidplatform.net";
    private WebView webView;
    private final ExecutorService network = Executors.newFixedThreadPool(6);
    private final Map<String, HttpURLConnection> requests = new ConcurrentHashMap<>();
    private final Map<String, Boolean> cancelled = new ConcurrentHashMap<>();
    private volatile URI endpoint;
    private volatile boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        // Apply status/navigation/IME insets natively; CSS viewport tracks the remaining space.
        webView.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets edges = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
                view.setPadding(edges.left, edges.top, edges.right, edges.bottom);
            }
            return insets;
        });
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("https".equals(url.getScheme()) && LOCAL_HOST.equals(url.getHost())) {
                    WebResourceResponse asset = assets.shouldInterceptRequest(url);
                    if (asset != null) return asset;
                }
                // Never load network documents, images or frames in the privileged WebView.
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", null, new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (request.isForMainFrame() && request.hasGesture() && target.getUserInfo() == null
                        && ("https".equals(target.getScheme()) || "http".equals(target.getScheme()))
                        && !LOCAL_HOST.equals(target.getHost())) {
                    try { startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, target)); }
                    catch (android.content.ActivityNotFoundException ignored) { /* No browser installed. */ }
                }
                return true;
            }
        });
        webView.addJavascriptInterface(new NetworkBridge(), "HarnessNative");
        setContentView(webView);
        webView.loadUrl("https://" + LOCAL_HOST + "/assets/index.html");
    }

    public final class NetworkBridge {
        @JavascriptInterface public synchronized String configure(String value) {
            try {
                URI next = RemoteEndpoint.parse(value);
                if (!cancelled.isEmpty()) throw new IllegalStateException("请等待上一次连接关闭后重试");
                endpoint = next;
                return new JSONObject().put("url", next.toString()).toString();
            } catch (Exception error) {
                return "{\"error\":" + JSONObject.quote(error.getMessage()) + "}";
            }
        }

        @JavascriptInterface public void request(String id, String url, String method, String headers, String body) {
            if (destroyed) return;
            if (!id.matches("[a-fA-F0-9-]{36}") || cancelled.size() >= 24 || cancelled.putIfAbsent(id, false) != null) {
                network.execute(() -> emitError(id, "并发请求过多，请稍后重试"));
                return;
            }
            URI authority = endpoint;
            network.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    URI target = new URI(url);
                    String route = RemoteEndpoint.route(authority, target);
                    if (!(method.equals("GET") || method.equals("POST")) || body.length() > 2 * 1024 * 1024) {
                        throw new IllegalArgumentException("无效的手机请求");
                    }
                    if (Boolean.TRUE.equals(cancelled.get(id))) return;
                    connection = (HttpURLConnection) target.toURL().openConnection();
                    requests.put(id, connection);
                    connection.setInstanceFollowRedirects(false); // Never forward credentials to a redirect.
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(route.endsWith("/events") ? 45000 : 15000);
                    connection.setRequestMethod(method);
                    JSONObject fields = new JSONObject(headers);
                    Iterator<String> names = fields.keys();
                    while (names.hasNext()) {
                        String name = names.next();
                        if (!RemoteEndpoint.allowedHeader(name)) {
                            throw new IllegalArgumentException("无效的请求头");
                        }
                        connection.setRequestProperty(name, fields.getString(name));
                    }
                    if (!body.isEmpty()) {
                        connection.setDoOutput(true);
                        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                        connection.setFixedLengthStreamingMode(bytes.length);
                        try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                    }
                    if (Boolean.TRUE.equals(cancelled.get(id))) return;
                    int status = connection.getResponseCode();
                    if (status >= 300 && status < 400) throw new IllegalStateException("服务器发生重定向，请填写最终 HTTPS 地址");
                    JSONObject responseHeaders = new JSONObject();
                    if (connection.getContentType() != null) responseHeaders.put("content-type", connection.getContentType());
                    emit(new JSONObject().put("id", id).put("type", "headers").put("status", status).put("headers", responseHeaders));
                    InputStream source = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                    long total = 0;
                    if (source != null) try (InputStream input = source) {
                        byte[] buffer = new byte[8192];
                        int size;
                        while (!destroyed && !Boolean.TRUE.equals(cancelled.get(id)) && (size = input.read(buffer)) != -1) {
                            total += size;
                            if (!route.endsWith("/events") && total > 32 * 1024 * 1024) throw new IllegalStateException("响应过大，请在桌面端查看");
                            emit(new JSONObject().put("id", id).put("type", "chunk").put("data", Base64.encodeToString(buffer, 0, size, Base64.NO_WRAP)));
                        }
                    }
                    emit(new JSONObject().put("id", id).put("type", "end"));
                } catch (Exception error) {
                    emitError(id, error.getMessage() == null ? "网络连接失败" : error.getMessage());
                } finally {
                    if (connection != null) connection.disconnect();
                    requests.remove(id);
                    cancelled.remove(id);
                }
            });
        }

        @JavascriptInterface public void cancel(String id) {
            if (cancelled.containsKey(id)) cancelled.put(id, true);
            HttpURLConnection connection = requests.get(id);
            if (connection != null) connection.disconnect();
        }
    }

    private void emitError(String id, String message) {
        try { emit(new JSONObject().put("id", id).put("type", "error").put("message", message)); }
        catch (Exception ignored) { /* Cannot deliver to a destroyed renderer. */ }
    }

    private void emit(JSONObject event) throws Exception {
        if (destroyed) return;
        CountDownLatch delivered = new CountDownLatch(1);
        runOnUiThread(() -> {
            if (destroyed) { delivered.countDown(); return; }
            webView.evaluateJavascript("window.__harnessHttp && window.__harnessHttp(" + event + ")", (result) -> delivered.countDown());
        });
        // Bound callbacks while the renderer is backgrounded or stalled.
        if (!delivered.await(15, TimeUnit.SECONDS)) throw new IllegalStateException("手机页面已暂停，请回到应用重新连接");
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null);
        }
    }

    @Override protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        requests.values().forEach(HttpURLConnection::disconnect);
        network.shutdownNow();
        webView.removeJavascriptInterface("HarnessNative");
        webView.destroy();
        super.onDestroy();
    }
}
