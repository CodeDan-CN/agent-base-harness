import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  path.join(process.env.HOME || '', 'Library/Android/sdk');
if (!existsSync(path.join(sdk, 'platforms/android-35/android.jar'))) {
  throw new Error(
    '未找到 Android SDK 35。请安装 Android Studio/SDK Platform 35 并设置 ANDROID_HOME。手机 UI 已构建，APK 尚未生成。',
  );
}
const gradle = process.env.AGENT_ANDROID_GRADLE || 'gradle';
const result = spawnSync(gradle, ['--no-daemon', 'assembleDebug'], {
  cwd: path.join(root, 'apps/mobile/android'),
  stdio: 'inherit',
  env: { ...process.env, ANDROID_HOME: sdk },
});
if (result.error)
  throw new Error('需要 JDK 17 与 Gradle 8.9；可用 AGENT_ANDROID_GRADLE 指定 Gradle 可执行文件。', {
    cause: result.error,
  });
if (result.status !== 0) process.exit(result.status || 1);
mkdirSync(path.join(root, 'release/mobile'), { recursive: true });
const output = path.join(root, 'release/mobile/agent-harness-mobile-debug.apk');
copyFileSync(
  path.join(root, 'apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk'),
  output,
);
console.log(`Debug APK: ${output} (开发签名，非正式发行包)`);
