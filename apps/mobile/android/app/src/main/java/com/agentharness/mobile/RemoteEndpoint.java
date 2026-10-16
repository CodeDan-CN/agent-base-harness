package com.agentharness.mobile;

import java.net.URI;
import java.util.Locale;

/** Network authority is selected explicitly, not derived from message or model content. */
public final class RemoteEndpoint {
    private RemoteEndpoint() {}

    public static URI parse(String value) throws Exception {
        if (value.length() > 4096) throw new IllegalArgumentException("服务器地址过长");
        URI uri = new URI(value.replaceAll("/+$", ""));
        String host = uri.getHost();
        if (host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || uri.getPort() > 65535 || uri.getPort() == 0 || !uri.normalize().equals(uri)
                || uri.getRawPath().contains("%") || uri.getRawPath().contains("//")) {
            throw new IllegalArgumentException("请输入不含账号、查询参数或片段的服务器地址");
        }
        host = host.toLowerCase(Locale.ROOT);
        if (host.equals("localhost") || host.endsWith(".localhost") || host.startsWith("127.") || host.equals("[::1]")) {
            throw new IllegalArgumentException("手机不运行 Runtime，请填写服务器或电脑的局域网地址");
        }
        if (!"https".equals(uri.getScheme()) && !("http".equals(uri.getScheme()) && privateIpv4(host))) {
            throw new IllegalArgumentException("远程服务器必须使用 HTTPS；HTTP 仅允许明确的局域网 IPv4 地址");
        }
        return uri;
    }

    private static boolean privateIpv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] values = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            values[i] = Integer.parseInt(parts[i]);
            if (values[i] > 255) return false;
        }
        return values[0] == 10 || (values[0] == 192 && values[1] == 168)
                || (values[0] == 172 && values[1] >= 16 && values[1] <= 31);
    }

    public static boolean allowedHeader(String name) {
        return name.matches("content-type|accept|x-agent-user|x-agent-client-kind|x-agent-connection-id|x-request-id");
    }

    public static String route(URI base, URI target) {
        if (base == null || !base.getScheme().equals(target.getScheme()) || !base.getRawAuthority().equals(target.getRawAuthority())
                || target.getRawFragment() != null || !target.normalize().equals(target)) {
            throw new IllegalArgumentException("请求不属于当前服务器");
        }
        String prefix = base.getRawPath();
        if (!target.getRawPath().startsWith(prefix + "/")) throw new IllegalArgumentException("无效的 API 路径");
        String route = target.getRawPath().substring(prefix.length());
        if (!(route.equals("/healthz") || route.equals("/v1/queries") || route.equals("/v1/commands")
                || route.matches("/v1/sessions/[a-zA-Z0-9_-]+/events"))) {
            throw new IllegalArgumentException("手机端未开放此接口");
        }
        return route;
    }
}
