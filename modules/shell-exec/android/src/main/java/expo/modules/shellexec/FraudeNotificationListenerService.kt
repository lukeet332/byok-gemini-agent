package expo.modules.shellexec

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.concurrent.ConcurrentLinkedDeque

// Captures incoming notifications (app / title / text / time) into a small
// in-memory ring buffer so the assistant can read & triage what's arrived. The
// user enables this in the system "Notification access" screen.
class FraudeNotificationListenerService : NotificationListenerService() {
  companion object {
    val recent = ConcurrentLinkedDeque<Map<String, Any>>()
    @Volatile
    var connected = false
    private const val MAX = 60
  }

  override fun onListenerConnected() {
    connected = true
  }

  override fun onListenerDisconnected() {
    connected = false
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    try {
      val ex = sbn.notification.extras
      val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
      val text = ex.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
      if (title.isBlank() && text.isBlank()) return
      recent.addFirst(mapOf("app" to sbn.packageName, "title" to title, "text" to text, "time" to sbn.postTime))
      while (recent.size > MAX) recent.removeLast()
    } catch (_: Throwable) {
      // ignore malformed notifications
    }
  }
}
