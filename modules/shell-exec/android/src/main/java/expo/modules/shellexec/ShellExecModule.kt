package expo.modules.shellexec

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.text.TextUtils
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import rikka.shizuku.Shizuku
import java.util.concurrent.TimeUnit

// Runs shell commands at three privilege levels:
//   - app    : `sh -c` in the app's own process (sandbox uid).
//   - root   : `su -c` (rooted devices only).
//   - shizuku: via Shizuku, which gives ADB/shell-uid (uid 2000) privileges on
//              NON-rooted devices once the user installs + starts the Shizuku app.
// stdout/stderr are drained on separate threads (so a full pipe can't deadlock),
// the command is killed past the timeout, and output is capped.
class ShellExecModule : Module() {
  private val permissionCode = 4216

  override fun definition() = ModuleDefinition {
    Name("ShellExec")

    // Run `sh -c` (app sandbox) or, when useSu, `su -c` (root).
    AsyncFunction("exec") { command: String, useSu: Boolean, timeoutMs: Int ->
      val argv = if (useSu) arrayOf("su", "-c", command) else arrayOf("sh", "-c", command)
      runProcess(Runtime.getRuntime().exec(argv), timeoutMs)
    }

    // Is the Shizuku service running, and have we been granted permission?
    AsyncFunction("shizukuStatus") {
      val running = try { Shizuku.pingBinder() } catch (_: Throwable) { false }
      val granted = running && try {
        !Shizuku.isPreV11() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
      } catch (_: Throwable) { false }
      mapOf("running" to running, "granted" to granted)
    }

    // Ask Shizuku for permission (shows Shizuku's own dialog). Resolves granted?
    AsyncFunction("requestShizukuPermission") { promise: Promise ->
      try {
        if (!Shizuku.pingBinder()) {
          promise.resolve(false)
          return@AsyncFunction
        }
        if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
          promise.resolve(true)
          return@AsyncFunction
        }
        val listener = object : Shizuku.OnRequestPermissionResultListener {
          override fun onRequestPermissionResult(requestCode: Int, grantResult: Int) {
            Shizuku.removeRequestPermissionResultListener(this)
            promise.resolve(grantResult == PackageManager.PERMISSION_GRANTED)
          }
        }
        Shizuku.addRequestPermissionResultListener(listener)
        Shizuku.requestPermission(permissionCode)
      } catch (e: Throwable) {
        promise.resolve(false)
      }
    }

    // Fire a command into Termux's environment (where pkg-installed toolchains —
    // python, node, clang, git — live) via its RUN_COMMAND service. We hold the
    // com.termux.permission.RUN_COMMAND permission. This is fire-and-forget;
    // redirect output to a file and read it back with run_shell (shizuku/root).
    AsyncFunction("runTermux") { commandLine: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction mapOf("ok" to false, "error" to "No context.")
      try {
        val intent = Intent().apply {
          setClassName("com.termux", "com.termux.app.RunCommandService")
          action = "com.termux.RUN_COMMAND"
          putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
          putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", commandLine))
          putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
        }
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
        mapOf("ok" to true)
      } catch (e: Throwable) {
        mapOf("ok" to false, "error" to (e.message ?: e.toString()))
      }
    }

    // All-files access — lets the app (uid) read /sdcard generally, so it can
    // read build output Termux wrote to a shared dir WITHOUT root or Shizuku.
    Function("hasAllFilesAccess") {
      if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else true
    }

    Function("requestAllFilesAccess") {
      val ctx = appContext.reactContext ?: return@Function false
      if (Build.VERSION.SDK_INT >= 30) {
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          .setData(Uri.parse("package:${ctx.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
          ctx.startActivity(intent)
        } catch (_: Throwable) {
          ctx.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      }
      true
    }

    // Android 16+ native Linux Terminal (AVF Debian VM) — a full Linux env for
    // coding. We can detect/launch it; driving it programmatically needs an SSH
    // bridge the user sets up inside the VM.
    Function("linuxTerminalStatus") {
      val ctx = appContext.reactContext
      val supported = Build.VERSION.SDK_INT >= 36
      var available = false
      if (ctx != null) {
        for (p in listOf("com.android.virtualization.terminal", "com.google.android.virtualization.terminal")) {
          try {
            ctx.packageManager.getPackageInfo(p, 0)
            available = true
            break
          } catch (_: Throwable) {}
        }
      }
      mapOf("supported" to supported, "available" to available, "sdk" to Build.VERSION.SDK_INT)
    }

    Function("openLinuxTerminal") {
      val ctx = appContext.reactContext ?: return@Function false
      for (p in listOf("com.android.virtualization.terminal", "com.google.android.virtualization.terminal")) {
        val intent = ctx.packageManager.getLaunchIntentForPackage(p)
        if (intent != null) {
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          ctx.startActivity(intent)
          return@Function true
        }
      }
      // Not installed/enabled → open Developer options to enable the Linux env.
      try {
        ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      } catch (_: Throwable) {}
      true
    }

    // If the app was launched via a "Share → Fraude" (ACTION_SEND) intent, return
    // the shared text/subject and consume it. Lets other apps push content in.
    Function("getShareIntent") {
      val act = appContext.currentActivity ?: return@Function null
      val intent = act.intent ?: return@Function null
      if (intent.action != Intent.ACTION_SEND) return@Function null
      val text = intent.getStringExtra(Intent.EXTRA_TEXT)
      val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
      // Consume it so a later resume doesn't re-handle the same share.
      intent.action = null
      intent.removeExtra(Intent.EXTRA_TEXT)
      if (text.isNullOrBlank()) null else mapOf("text" to text, "subject" to (subject ?: ""))
    }

    // ---- Notification access (read incoming notifications) ----

    Function("notificationsEnabled") {
      val ctx = appContext.reactContext ?: return@Function false
      val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return@Function false
      flat.contains(ctx.packageName)
    }

    Function("openNotificationSettings") {
      val ctx = appContext.reactContext ?: return@Function false
      ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    }

    AsyncFunction("getRecentNotifications") { limit: Int ->
      val n = if (limit in 1..60) limit else 30
      FraudeNotificationListenerService.recent.toList().take(n)
    }

    // ---- Accessibility-based UI automation (no root / Shizuku needed) ----

    // Is our accessibility service enabled in system settings?
    Function("a11yEnabled") {
      val ctx = appContext.reactContext ?: return@Function false
      isA11yEnabled(ctx)
    }

    // Open the system Accessibility settings so the user can enable Fraude.
    Function("openA11ySettings") {
      val ctx = appContext.reactContext ?: return@Function false
      val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
      ctx.startActivity(intent)
      true
    }

    // Open this app's App-info page — where Android 13+ requires the user to tap
    // ⋮ → "Allow restricted settings" before a sideloaded app's accessibility
    // toggle can be turned on.
    Function("openAppInfo") {
      val ctx = appContext.reactContext ?: return@Function false
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        .setData(Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
      true
    }

    // Read the current screen (node tree) so the AI can decide what to act on.
    AsyncFunction("a11yDump") {
      FraudeAccessibilityService.instance?.dump() ?: "Accessibility service not enabled. Turn it on in Settings → Developer settings."
    }

    AsyncFunction("a11yTapText") { text: String -> FraudeAccessibilityService.instance?.tapText(text) ?: false }
    AsyncFunction("a11yTapId") { id: String -> FraudeAccessibilityService.instance?.tapId(id) ?: false }
    AsyncFunction("a11ySetText") { text: String -> FraudeAccessibilityService.instance?.setText(text) ?: false }
    AsyncFunction("a11yGlobal") { action: String -> FraudeAccessibilityService.instance?.global(action) ?: false }

    // Run a command through Shizuku (shell-uid).
    AsyncFunction("execShizuku") { command: String, timeoutMs: Int ->
      try {
        if (!Shizuku.pingBinder())
          return@AsyncFunction errorResult("Shizuku isn't running. Install + start the Shizuku app first.")
        if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED)
          return@AsyncFunction errorResult("Shizuku permission not granted. Grant it in Settings.")
        runProcess(shizukuNewProcess(arrayOf("sh", "-c", command)), timeoutMs)
      } catch (e: Throwable) {
        errorResult("Shizuku exec failed: ${e.message ?: e.toString()}")
      }
    }
  }

  // Shizuku exposes process creation via a hidden static method; call it
  // reflectively (same Process interface as Runtime.exec).
  private fun shizukuNewProcess(cmd: Array<String>): Process {
    val m = Shizuku::class.java.getDeclaredMethod(
      "newProcess",
      Array<String>::class.java,
      Array<String>::class.java,
      String::class.java
    )
    m.isAccessible = true
    return m.invoke(null, cmd, null, null) as Process
  }

  private fun isA11yEnabled(ctx: android.content.Context): Boolean {
    if (FraudeAccessibilityService.instance != null) return true
    val flat = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
    val target = "${ctx.packageName}/${FraudeAccessibilityService::class.java.name}"
    val splitter = TextUtils.SimpleStringSplitter(':')
    splitter.setString(flat)
    for (name in splitter) if (name.equals(target, ignoreCase = true)) return true
    return false
  }

  private fun errorResult(message: String): Map<String, Any> =
    mapOf("stdout" to "", "stderr" to message, "exitCode" to -1, "timedOut" to false)

  private fun runProcess(process: Process, timeoutMs: Int): Map<String, Any> {
    val outBuf = StringBuilder()
    val errBuf = StringBuilder()
    val outThread = Thread {
      try {
        process.inputStream.bufferedReader().forEachLine { synchronized(outBuf) { outBuf.append(it).append('\n') } }
      } catch (_: Throwable) {}
    }
    val errThread = Thread {
      try {
        process.errorStream.bufferedReader().forEachLine { synchronized(errBuf) { errBuf.append(it).append('\n') } }
      } catch (_: Throwable) {}
    }
    outThread.start()
    errThread.start()

    val limit = if (timeoutMs > 0) timeoutMs.toLong() else 60000L
    val finished = process.waitFor(limit, TimeUnit.MILLISECONDS)
    if (!finished) process.destroyForcibly()
    outThread.join(2000)
    errThread.join(2000)

    val max = 60000
    fun cap(s: String) = if (s.length > max) s.substring(0, max) + "\n...[truncated]" else s

    return mapOf(
      "stdout" to cap(synchronized(outBuf) { outBuf.toString() }),
      "stderr" to cap(synchronized(errBuf) { errBuf.toString() }),
      "exitCode" to if (finished) process.exitValue() else -1,
      "timedOut" to !finished
    )
  }
}
