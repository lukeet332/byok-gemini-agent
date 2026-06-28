package expo.modules.shellexec

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

// App-agnostic UI automation: reads the current screen's accessibility node tree
// and clicks/types semantically (by text / resource-id), so it's robust across
// apps and screen sizes — no root or Shizuku needed (the user enables this once
// in Accessibility settings). The Expo module talks to the running instance.
class FraudeAccessibilityService : AccessibilityService() {
  companion object {
    @Volatile
    var instance: FraudeAccessibilityService? = null
  }

  override fun onServiceConnected() {
    instance = this
  }

  override fun onDestroy() {
    instance = null
    super.onDestroy()
  }

  override fun onInterrupt() {}
  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

  // A compact text dump of the current screen's actionable / labelled nodes.
  fun dump(): String {
    val root = rootInActiveWindow ?: return "(no active window — is an app open?)"
    val sb = StringBuilder()
    walk(root, sb, 0)
    val s = sb.toString()
    return if (s.length > 20000) s.substring(0, 20000) + "\n…[truncated]" else s
  }

  private fun walk(node: AccessibilityNodeInfo?, sb: StringBuilder, depth: Int) {
    if (node == null || depth > 40) return
    val text = node.text?.toString()
    val desc = node.contentDescription?.toString()
    val id = node.viewIdResourceName
    val cls = node.className?.toString()?.substringAfterLast('.')
    if (!text.isNullOrBlank() || !desc.isNullOrBlank() || node.isClickable || node.isEditable) {
      val r = Rect()
      node.getBoundsInScreen(r)
      sb.append("• ")
      if (!text.isNullOrBlank()) sb.append("\"").append(text).append("\" ")
      if (!desc.isNullOrBlank()) sb.append("(desc: ").append(desc).append(") ")
      if (id != null) sb.append("id=").append(id).append(' ')
      if (cls != null) sb.append('[').append(cls).append("] ")
      if (node.isClickable) sb.append("CLICKABLE ")
      if (node.isEditable) sb.append("EDITABLE ")
      sb.append("@").append(r.centerX()).append(',').append(r.centerY()).append('\n')
    }
    for (i in 0 until node.childCount) walk(node.getChild(i), sb, depth + 1)
  }

  fun tapText(text: String): Boolean {
    val root = rootInActiveWindow ?: return false
    // 1) Fast path: a node whose visible text matches.
    root.findAccessibilityNodeInfosByText(text)?.firstOrNull()?.let { return clickNode(it) }
    // 2) Fallback: match by contentDescription too. Most icon buttons (WhatsApp's
    //    "Send" FAB, Messages' "Send SMS") expose their label ONLY as a
    //    contentDescription — often on a non-clickable child whose clickable parent
    //    carries just a resource-id — so findByText misses them entirely.
    val match = findByTextOrDesc(root, text.trim().lowercase()) ?: return false
    return clickNode(match)
  }

  // Best node whose visible text or contentDescription matches (case-insensitive),
  // preferring exact matches and ones that are (or sit under) a clickable element.
  private fun findByTextOrDesc(root: AccessibilityNodeInfo, q: String): AccessibilityNodeInfo? {
    if (q.isEmpty()) return null
    var best: AccessibilityNodeInfo? = null
    var bestScore = 0
    fun visit(n: AccessibilityNodeInfo?) {
      if (n == null) return
      val t = n.text?.toString()?.trim()?.lowercase()
      val d = n.contentDescription?.toString()?.trim()?.lowercase()
      var score = when {
        t == q || d == q -> 4
        d != null && d.contains(q) -> 3
        t != null && t.contains(q) -> 2
        else -> 0
      }
      if (score > 0) {
        if (n.isClickable || hasClickableAncestor(n)) score += 1
        if (score > bestScore) { bestScore = score; best = n }
      }
      for (i in 0 until n.childCount) visit(n.getChild(i))
    }
    visit(root)
    return best
  }

  private fun hasClickableAncestor(node: AccessibilityNodeInfo): Boolean {
    var n: AccessibilityNodeInfo? = node.parent
    while (n != null) {
      if (n.isClickable) return true
      n = n.parent
    }
    return false
  }

  fun tapId(id: String): Boolean {
    val root = rootInActiveWindow ?: return false
    val node = root.findAccessibilityNodeInfosByViewId(id)?.firstOrNull() ?: return false
    return clickNode(node)
  }

  private fun clickNode(node: AccessibilityNodeInfo): Boolean {
    var n: AccessibilityNodeInfo? = node
    while (n != null && !n.isClickable) n = n.parent
    if (n != null && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
    val r = Rect()
    node.getBoundsInScreen(r)
    return tapAt(r.centerX(), r.centerY())
  }

  fun tapAt(x: Int, y: Int): Boolean {
    val path = Path()
    path.moveTo(x.toFloat(), y.toFloat())
    val gesture = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(path, 0, 50))
      .build()
    return dispatchGesture(gesture, null, null)
  }

  fun setText(text: String): Boolean {
    val node = findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
    val args = Bundle()
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
  }

  fun global(action: String): Boolean {
    val a = when (action.lowercase()) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recents" -> GLOBAL_ACTION_RECENTS
      "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
      else -> return false
    }
    return performGlobalAction(a)
  }
}
