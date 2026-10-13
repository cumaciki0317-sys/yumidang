/* Approved browse → detail preview only. Each screen is loaded from its single source. */
(() => {
  'use strict';
  const frame = document.createElement('iframe');
  frame.title = '선택한 공고 상세';
  frame.hidden = true;
  frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100dvh;border:0;z-index:1000;background:transparent';
  document.body.append(frame);
  const flow = 'yd-browse-detail-preview';
  let selected = null, lastCard = null, ready = false, epoch = 0, closing = false;
  const suspended = new Map();
  const send = message => frame.contentWindow.postMessage(message, location.origin);
  function suspend(active) {
    if (active) {
      for (const element of document.body.children) {
        if (element === frame || ['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName)) continue;
        if (!suspended.has(element)) suspended.set(element, element.inert);
        element.inert = true;
      }
    } else {
      for (const [element, inert] of suspended) element.inert = inert;
      suspended.clear();
    }
  }
  function show(selection) {
    selected = selection;
    closing = false;
    epoch++;
    suspend(true);
    if (ready) send({type:'yd-show-listing', record:selected.record, scenario:selected.scenario, guest:selected.scenario==='guest', epoch});
  }
  function finish() {
    frame.hidden = true;
    suspend(false);
    selected = null;
    closing = false;
    if (lastCard?.isConnected) lastCard.focus({preventScroll:true});
  }
  history.replaceState({...history.state, ydFlow:flow, screen:'browse'}, '');
  window.addEventListener('yumidang:browse-detail', event => {
    if (selected || ![1,2,3,4].includes(Number(event.detail?.id))) return;
    lastCard = document.querySelector('[data-detail="'+event.detail.id+'"]');
    const selection = {record:event.detail.record, scenario:event.detail.scenario};
    history.pushState({ydFlow:flow, screen:'detail', selection}, '');
    show(selection);
    if (!frame.hasAttribute('src')) frame.src = '../유미당-공고상세-소스/유미당-공고상세.html?connected=1';
  });
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.type === 'yd-detail-ready') {
      ready = true;
      if (selected) show(selected);
    } else if (message?.type === 'yd-detail-rendered' && selected && message.epoch === epoch) {
      frame.hidden = false;
      send({type:'yd-focus-detail'});
    } else if (message?.type === 'yd-close-detail' && selected && !closing && message.epoch === epoch) {
      closing = true;
      history.back();
    } else if (message?.type === 'yd-detail-hidden' && message.epoch === epoch) finish();
  });
  window.addEventListener('popstate', event => {
    const state = event.state;
    if (state?.ydFlow === flow && state.screen === 'detail' && state.selection) show(state.selection);
    else {
      epoch++;
      selected = null;
      if (ready && !frame.hidden) send({type:'yd-hide-detail', epoch});
      else finish();
    }
  });
})();
