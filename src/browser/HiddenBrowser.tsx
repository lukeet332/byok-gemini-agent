// An off-screen, programmatically-driven WebView. It loads pages in a real
// browser engine (so JavaScript renders), then injects a script to extract the
// readable text (or structured search results) and posts it back. Requests are
// queued and served one at a time. Registers itself with BrowserEngine so the
// agent can call fetchPage()/search() imperatively.

import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";

import { BrowserEngine, PageResult, SearchResult } from "./BrowserEngine";

const DEFAULT_TIMEOUT = 22000;
const DDG = "https://html.duckduckgo.com/html/?q=";

type Kind = "page" | "search";

interface Req {
  id: number;
  kind: Kind;
  target: string; // url (page) or query (search)
  navUrl: string;
  timeoutMs: number;
  resolve: (r: any) => void;
  injected: boolean;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

// Self-polling extractors: post back as soon as content is ready (fast pages
// return quickly), or after ~6s for slow JS pages. No fixed wait penalty.
function pageExtract(id: number): string {
  return `(function(){var id=${id},n=0;function s(p){try{window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({__id:id},p)))}catch(e){}}
    function g(){return document.body?(document.body.innerText||''):''}
    function tick(){n++;var t=g();if((document.readyState==='complete'&&t.length>200)||n>24){s({ok:true,title:document.title||'',text:t.slice(0,200000)});return}setTimeout(tick,250)}tick()})();true;`;
}

function searchExtract(id: number): string {
  return `(function(){var id=${id},n=0;function s(p){try{window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({__id:id},p)))}catch(e){}}
    function tick(){n++;var as=document.querySelectorAll('a.result__a');if(as.length>0||n>24){var out=[];for(var i=0;i<as.length&&out.length<10;i++){var a=as[i];var href=a.href||'';var m=href.match(/uddg=([^&]+)/);var url=m?decodeURIComponent(m[1]):href;var sn='';var r=a.closest('.result');if(r){var q=r.querySelector('.result__snippet');if(q)sn=q.innerText}out.push({title:(a.innerText||'').trim(),url:url,snippet:(sn||'').trim()})}s({ok:true,results:out});return}setTimeout(tick,250)}tick()})();true;`;
}

export default function HiddenBrowser() {
  const webRef = useRef<WebView>(null);
  const [nav, setNav] = useState<{ url: string; key: string }>({ url: "about:blank", key: "idle" });
  const queue = useRef<Req[]>([]);
  const current = useRef<Req | null>(null);
  const idSeq = useRef(0);

  function settle(id: number, payload: any) {
    const cur = current.current;
    if (!cur || cur.id !== id) return;
    if (cur.timer) clearTimeout(cur.timer);
    if (cur.signal && cur.onAbort) cur.signal.removeEventListener("abort", cur.onAbort);
    cur.resolve(payload);
    current.current = null;
    setNav({ url: "about:blank", key: "idle-" + id });
    setTimeout(processNext, 0);
  }

  function processNext() {
    if (current.current) return;
    const next = queue.current.shift();
    if (!next) return;
    current.current = next;
    setNav({ url: next.navUrl, key: "req-" + next.id });
    next.timer = setTimeout(() => {
      settle(next.id, errPayload(next, "timeout"));
    }, next.timeoutMs);
  }

  function errPayload(req: Req, error: string): PageResult | SearchResult {
    return req.kind === "search"
      ? { ok: false, query: req.target, error }
      : { ok: false, url: req.target, error };
  }

  function enqueue(kind: Kind, target: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<any> {
    return new Promise((resolve) => {
      const id = ++idSeq.current;
      const navUrl = kind === "search" ? DDG + encodeURIComponent(target) : target;
      const req: Req = { id, kind, target, navUrl, timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT, resolve, injected: false };
      if (opts?.signal) {
        if (opts.signal.aborted) return resolve(errPayload(req, "aborted"));
        req.signal = opts.signal;
        req.onAbort = () => {
          queue.current = queue.current.filter((r) => r.id !== id);
          if (current.current?.id === id) settle(id, errPayload(req, "aborted"));
          else resolve(errPayload(req, "aborted"));
        };
        opts.signal.addEventListener("abort", req.onAbort);
      }
      queue.current.push(req);
      processNext();
    });
  }

  useEffect(() => {
    BrowserEngine.register({
      fetchPage: (url, opts) => enqueue("page", url, opts) as Promise<PageResult>,
      search: (query, opts) => enqueue("search", query, opts) as Promise<SearchResult>,
    });
    return () => BrowserEngine.register(null);
  }, []);

  function onLoadEnd() {
    const cur = current.current;
    if (!cur || cur.injected) return;
    cur.injected = true;
    // The injected script polls for readiness itself, so inject immediately.
    webRef.current?.injectJavaScript(cur.kind === "search" ? searchExtract(cur.id) : pageExtract(cur.id));
  }

  function onMessage(e: WebViewMessageEvent) {
    let msg: any;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (typeof msg.__id !== "number") return;
    const cur = current.current;
    if (!cur || cur.id !== msg.__id) return;
    if (cur.kind === "search") settle(cur.id, { ok: !!msg.ok, query: cur.target, results: msg.results || [], error: msg.error });
    else settle(cur.id, { ok: !!msg.ok, url: cur.target, title: msg.title, text: msg.text, error: msg.error });
  }

  function onError() {
    const cur = current.current;
    if (cur) settle(cur.id, errPayload(cur, "navigation failed"));
  }

  return (
    <View style={styles.offscreen} pointerEvents="none">
      <WebView
        ref={webRef}
        key={nav.key}
        source={{ uri: nav.url }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        onLoadEnd={onLoadEnd}
        onMessage={onMessage}
        onError={onError}
        onHttpError={onError}
        setSupportMultipleWindows={false}
        // Software layer = renders into the view tree (respects offscreen/opacity)
        // instead of a hardware surface that flashes white over the app at init.
        androidLayerType="software"
        style={styles.web}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Off-screen but with real layout size so JS pages actually render.
  offscreen: { position: "absolute", width: 390, height: 720, left: -10000, top: 0, opacity: 0 },
  web: { backgroundColor: "transparent", flex: 1 },
});
