'use strict';

// Chromium on macOS intermittently logs task_policy_set failures to stderr
// while starting (a known harmless kernel/process message). Keep those out of
// the strict stderr assertions while still failing on real renderer errors.
const MACOS_TASK_POLICY_NOISE = /task_policy_set|TASK_SUPPRESSION_POLICY|TASK_CATEGORY_POLICY|\(os\/kern\) invalid argument/;
// Headless Linux (CI, cloud containers under xvfb) has no system D-Bus and
// often no GPU; Chromium reports both on every start (T-12).
const LINUX_HEADLESS_NOISE = /Failed to connect to the bus|bus\.cc|dbus|viz_main_impl|Exiting GPU process|gpu_init|gl_display|gl_surface|angle_platform|GPU process|Fontconfig|libva|MESA|vaInitialize|sandbox_linux/i;
const NOISE = process.platform === 'linux'
  ? line => MACOS_TASK_POLICY_NOISE.test(line) || LINUX_HEADLESS_NOISE.test(line)
  : line => MACOS_TASK_POLICY_NOISE.test(line);

function assertCleanElectronStderr(assert, stderr, label) {
  const meaningful = stderr.split('\n')
    .filter(line => line.trim() && !NOISE(line))
    .join('\n');
  assert.equal(meaningful, '', `${label} reported stderr: ${meaningful}`);
}

module.exports = { assertCleanElectronStderr };
