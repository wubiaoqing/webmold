// 欢迎页逻辑：引导用户去设置模型/ 关闭页面开始使用。

const $ = (id) => document.getElementById(id);

//「去配置模型」→ 打开扩展设置页
$('openOptions')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 「先随便看看」→ 直接关掉这个欢迎标签页
$('skipBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.getCurrent((tab) => {
    if (tab?.id != null) chrome.tabs.remove(tab.id);
  });
});
