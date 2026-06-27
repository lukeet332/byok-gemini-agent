package expo.modules.shellexec

import android.content.pm.PackageManager
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
