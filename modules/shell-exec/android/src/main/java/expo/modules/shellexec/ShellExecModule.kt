package expo.modules.shellexec

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.TimeUnit

// Runs a shell command in the app's process (`sh -c`) or, when the device is
// rooted and the caller opts in, as root (`su -c`). stdout/stderr are drained on
// separate threads so a full pipe buffer can't deadlock the process, and the
// command is killed if it exceeds the timeout. Output is capped to keep the
// model's context (and cost) bounded.
class ShellExecModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShellExec")

    AsyncFunction("exec") { command: String, useSu: Boolean, timeoutMs: Int ->
      val argv = if (useSu) arrayOf("su", "-c", command) else arrayOf("sh", "-c", command)
      val process = Runtime.getRuntime().exec(argv)

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

      mapOf(
        "stdout" to cap(synchronized(outBuf) { outBuf.toString() }),
        "stderr" to cap(synchronized(errBuf) { errBuf.toString() }),
        "exitCode" to if (finished) process.exitValue() else -1,
        "timedOut" to !finished
      )
    }
  }
}
