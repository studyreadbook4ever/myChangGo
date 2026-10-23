import type { Language } from "./types";
export const historyCopy: Record<
  Language,
  {
    title: string;
    empty: string;
    refresh: string;
    request: string;
    preparing: string;
    stages: Record<string, string>;
  }
> = {
  ko: {
    title: "내 주문",
    empty: "아직 주문한 내역이 없어요.",
    refresh: "새로 확인하기",
    request: "말로 요청",
    preparing: "직원에게 전달할 내용을 준비하고 있어요",
    stages: {
      new: "주문 접수",
      accepted: "직원 확인",
      cooking: "조리 중",
      ready: "준비 완료",
      served: "제공 완료",
      closed: "이용 완료",
    },
  },
  en: {
    title: "My orders",
    empty: "No orders yet.",
    refresh: "Check again",
    request: "Voice request",
    preparing: "Preparing your request for our team",
    stages: {
      new: "Order received",
      accepted: "Staff confirmed",
      cooking: "Cooking",
      ready: "Ready",
      served: "Served",
      closed: "Completed",
    },
  },
  ja: {
    title: "注文履歴",
    empty: "まだ注文がありません。",
    refresh: "再確認する",
    request: "声でお願い",
    preparing: "スタッフへ伝える内容を準備しています",
    stages: {
      new: "注文受付",
      accepted: "スタッフ確認",
      cooking: "調理中",
      ready: "準備完了",
      served: "提供済み",
      closed: "ご利用完了",
    },
  },
  zh: {
    title: "我的订单",
    empty: "暂无订单。",
    refresh: "重新查看",
    request: "语音请求",
    preparing: "正在准备向工作人员转达您的请求",
    stages: {
      new: "订单已接收",
      accepted: "工作人员已确认",
      cooking: "制作中",
      ready: "已备好",
      served: "已上餐",
      closed: "已完成",
    },
  },
};
