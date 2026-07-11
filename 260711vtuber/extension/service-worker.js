const enableActionSidePanel = async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error("사이드패널 동작을 설정하지 못했습니다.", error);
  }
};

chrome.runtime.onInstalled.addListener(enableActionSidePanel);
chrome.runtime.onStartup.addListener(enableActionSidePanel);

void enableActionSidePanel();
