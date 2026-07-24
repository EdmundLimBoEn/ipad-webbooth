export const SUPPORTED_LOCALES = ["en", "zh-SG", "ar"] as const;

export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

export const englishMessages = {
  boothKeyPrompt: "Enter this event's booth key",
  queueStarting: "Photo queue is still starting — please try again",
  lastPhoto: "Last photo",
  pickStyle: "Pick a style",
  noFrames: "No frames are enabled for this event yet.",
  onePhoto: "1 photo",
  photoCount: "{count} photos",
  cameraUnavailable: "Camera unavailable. Use your device camera instead:",
  takePhoto: "Take a photo",
  startCapture: "Start",
  changeFrame: "{frame} · change",
  liveGallery: "Live",
  uploading: "Uploading {count}…",
  retryPending: "Retry {count} pending",
  offlineStorageUnavailable:
    "Offline photo storage is unavailable. Pending photos may be lost if this page reloads.",
  usePhoto: "Use Photo",
  retake: "Retake",
  moreTime: "More Time",
  accepting: "Saving photo…",
  preview: "Photo preview",
  queued: "Photo safely queued.",
  handoffTitle: "Your photo is ready",
  handoffBody: "Scan to open this photo on your phone.",
  viewPhoto: "View photo",
  galleryLoading: "Opening your photo…",
  galleryInvalid: "This photo link is invalid.",
  galleryNotFound: "This photo is no longer available.",
  galleryOffline: "You’re offline. Reconnect and try again.",
  galleryUnavailable: "We couldn’t open this photo.",
  galleryRetry: "Try again",
  gallerySave: "Save or share",
  gallerySaveError: "Couldn’t save this photo. Try again.",
  nextGuest: "Next guest",
  pausedTitle: "Booth paused",
  countdownShot: "Photo {shot} of {total}",
} satisfies Record<string, string>;

export type MessageKey = keyof typeof englishMessages;

export const chineseSingaporeMessages: Record<MessageKey, string> = {
  boothKeyPrompt: "请输入此活动的拍照亭密钥",
  queueStarting: "照片队列仍在启动，请重试",
  lastPhoto: "上一张照片",
  pickStyle: "选择相框",
  noFrames: "此活动尚未启用任何相框。",
  onePhoto: "1 张照片",
  photoCount: "{count} 张照片",
  cameraUnavailable: "无法使用相机。请改用设备相机：",
  takePhoto: "拍照",
  startCapture: "开始",
  changeFrame: "{frame} · 更换",
  liveGallery: "现场相册",
  uploading: "正在上传 {count} 张…",
  retryPending: "重试 {count} 张待上传照片",
  offlineStorageUnavailable: "无法使用离线照片存储。重新加载此页面可能会丢失待上传照片。",
  usePhoto: "使用照片",
  retake: "重拍",
  moreTime: "需要更多时间",
  accepting: "正在保存照片…",
  preview: "照片预览",
  queued: "照片已安全加入队列。",
  handoffTitle: "您的照片已准备好",
  handoffBody: "扫描二维码，在手机上打开此照片。",
  viewPhoto: "查看照片",
  galleryLoading: "正在打开您的照片…",
  galleryInvalid: "此照片链接无效。",
  galleryNotFound: "此照片已无法查看。",
  galleryOffline: "您目前处于离线状态。请重新连接后再试。",
  galleryUnavailable: "无法打开此照片。",
  galleryRetry: "重试",
  gallerySave: "保存或分享",
  gallerySaveError: "无法保存此照片。请重试。",
  nextGuest: "下一位来宾",
  pausedTitle: "拍照亭已暂停",
  countdownShot: "第 {shot} 张，共 {total} 张",
};

export const arabicMessages: Record<MessageKey, string> = {
  boothKeyPrompt: "أدخل مفتاح كشك التصوير لهذا الحدث",
  queueStarting: "لا تزال قائمة انتظار الصور قيد البدء — حاول مرة أخرى",
  lastPhoto: "الصورة السابقة",
  pickStyle: "اختر إطارًا",
  noFrames: "لم يتم تفعيل أي إطارات لهذا الحدث بعد.",
  onePhoto: "صورة واحدة",
  photoCount: "{count} صور",
  cameraUnavailable: "الكاميرا غير متاحة. استخدم كاميرا جهازك بدلًا منها:",
  takePhoto: "التقط صورة",
  startCapture: "ابدأ",
  changeFrame: "تغيير · {frame}",
  liveGallery: "المعرض المباشر",
  uploading: "جارٍ رفع {count}…",
  retryPending: "أعد محاولة رفع {count} معلّقة",
  offlineStorageUnavailable:
    "تخزين الصور دون اتصال غير متاح. قد تُفقد الصور المعلّقة إذا أُعيد تحميل هذه الصفحة.",
  usePhoto: "استخدم الصورة",
  retake: "أعد الالتقاط",
  moreTime: "وقت إضافي",
  accepting: "جارٍ حفظ الصورة…",
  preview: "معاينة الصورة",
  queued: "أُضيفت الصورة إلى قائمة الانتظار بأمان.",
  handoffTitle: "صورتك جاهزة",
  handoffBody: "امسح الرمز لفتح هذه الصورة على هاتفك.",
  viewPhoto: "اعرض الصورة",
  galleryLoading: "جارٍ فتح صورتك…",
  galleryInvalid: "رابط هذه الصورة غير صالح.",
  galleryNotFound: "هذه الصورة لم تعد متاحة.",
  galleryOffline: "أنت غير متصل. أعد الاتصال وحاول مرة أخرى.",
  galleryUnavailable: "تعذر فتح هذه الصورة.",
  galleryRetry: "حاول مرة أخرى",
  gallerySave: "احفظ أو شارك",
  gallerySaveError: "تعذر حفظ هذه الصورة. حاول مرة أخرى.",
  nextGuest: "الضيف التالي",
  pausedTitle: "كشك التصوير متوقف مؤقتًا",
  countdownShot: "الصورة {shot} من {total}",
};

const catalogs: Record<SupportedLocale, Record<MessageKey, string>> = {
  en: englishMessages,
  "zh-SG": chineseSingaporeMessages,
  ar: arabicMessages,
};

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string"
    && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function message(
  locale: SupportedLocale,
  key: MessageKey,
  values: Record<string, string | number> = {}
): string {
  const template = catalogs[locale]?.[key] ?? englishMessages[key];
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  );
}

export function localeDirection(locale: SupportedLocale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}
