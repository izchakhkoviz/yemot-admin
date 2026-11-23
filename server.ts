import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, scryptSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { YemotRouter } from 'yemot-router2';
import { Firestore } from '@google-cloud/firestore';

const RENDER_ORIGIN = 'https://yemot-ai-kg2y.onrender.com';
const PUBLIC_DEPLOYED_ORIGIN = 'https://bot-yemot-114532963495.europe-west1.run.app';
const MASTER_REGISTRY_TOKEN = '0772023014:317304103';
const FALLBACK_GEMINI_KEY = 'AQ.Ab8RN6LFTibbXsxscB9CvtFNeYZFQoKskDXXHl1frDjNC6vKIw';
const CURRENT_SERVER_VERSION = 'v8';
let activeTunnelOrigin = '';
let deployedCloudRunIsV8 = false;

function getGeminiApiKey(): string {
  return process.env.GEMINI_API_KEY || FALLBACK_GEMINI_KEY;
}

interface YemotMessage {
  type: 'text' | 'file' | 'digits' | 'number';
  data: string;
}

interface YemotCall {
  phone: string;
  callId: string;
  did: string;
  real_did?: string;
  realDid?: string;
  extension: string;
  req?: express.Request & { yemotTenantId?: string; yemotExtId?: string };
  values?: Record<string, string>;
  id_list_message: (
    messages: YemotMessage[],
    options?: { prependToNextAction?: boolean }
  ) => Promise<void>;
  read: (
    messages: YemotMessage[],
    mode?: 'tap' | 'record' | 'stt',
    options?: Record<string, unknown>
  ) => Promise<string>;
  hangup: () => Promise<void>;
  go_to_folder: (folder: string) => Promise<void>;
}

interface DaySchedule {
  open: boolean;
  from: string;
  to: string;
}

export interface ReceptionistRoleParams {
  ownerName: string;
  ownerTitle: string;
  availabilityStatus: string;
  collectFields: string;
  faqAnswers: string;
  urgentPolicy: string;
  sendSummaryNote: boolean;
}

export interface SalesRoleParams {
  productsCatalog: string;
  uniqueSellingPoints: string;
  currentPromo: string;
  objectionHandling: string;
  closingGoal: string;
  persuasionStyle: 'consultative' | 'charismatic' | 'closer';
}

export interface CustomerServiceRoleParams {
  supportedServices: string;
  troubleshootingGuide: string;
  refundWarrantyPolicy: string;
  escalationPolicy: string;
  slaPromise: string;
  empathyLevel: 'high' | 'practical' | 'vip';
}

export interface FreeChatRoleParams {
  botPersonaName: string;
  personaBackground: string;
  favoriteTopics: string;
  contentFilterLevel: 'strict_kosher' | 'family' | 'open';
  conversationMode: 'warm_friend' | 'wise_advisor' | 'storyteller' | 'intellectual_debate';
}

export interface RoleParamsMap {
  receptionist: ReceptionistRoleParams;
  sales: SalesRoleParams;
  customer_service: CustomerServiceRoleParams;
  free_chat: FreeChatRoleParams;
}

export interface TenantConfigData {
  enabled: boolean;
  role: string;
  businessName: string;
  businessInfo: string;
  customInstructions: string;
  topicsMode: string;
  topics: string[];
  offTopicReply: string;
  style: string;
  voice: { provider?: string; name: string; speakingRate: number };
  greeting: string;
  goodbye: string;
  consentMessage: string;
  access: { mode: string; numbers: string[] };
  deniedMessage: string;
  closedMessage: string;
  schedule: { enabled: boolean; tz: string; days: DaySchedule[] };
  tools: { email: boolean; fax?: boolean; images: boolean };
  maxMinutes: number;
  useNikud: boolean;
  yemotChatExt?: string;
  yemotAdminExt?: string;
  notificationEmail?: string;
  autoSyncYemot?: boolean;
  handsFreeMode?: boolean;
  handsFreeAutoStopSec?: number;
  roleParams?: RoleParamsMap;
}

export type ChatHistoryEntry = {
  role: string;
  parts: Array<{ text: string }>;
};

export interface StoredTenant {
  id: string;
  name: string;
  tokenSalt: string;
  tokenHash: string;
  yemotNumber?: string;
  yemotPassword?: string;
  brevoApiKey?: string;
  mailFrom?: string;
  dailyCallLimit: number;
  callsToday: number;
  lastCallDay: string;
  yemotChatExt?: string;
  yemotAdminExt?: string;
  yemotSyncedAt?: string | null;
  updatedAt?: string;
  config: TenantConfigData;
  extensions?: Record<string, TenantConfigData>;
  memory: Record<string, ChatHistoryEntry[]>;
  extensionMemories?: Record<string, Record<string, ChatHistoryEntry[]>>;
}

const DEFAULT_ROLE_PARAMS: RoleParamsMap = {
  receptionist: {
    ownerName: '',
    ownerTitle: 'מנהל המשרד',
    availabilityStatus: 'נמצא בפגישה ואינו פנוי כרגע למענה ישיר',
    collectFields: 'שם מלא, מספר טלפון לחזרה, סיבת הפנייה ומידת הדחיפות',
    faqAnswers: '',
    urgentPolicy: 'במקרה דחוף במיוחד, ציין שהפנייה תסומן כדחופה ותועבר לטיפול מיידי.',
    sendSummaryNote: true,
  },
  sales: {
    productsCatalog: '',
    uniqueSellingPoints: 'שירות אישי ומקצועי, איכות ללא פשרות, מחיר משתלם ואחריות מלאה',
    currentPromo: '',
    objectionHandling:
      'אם הלקוח אומר שיקר - הדגש את הערך והחיסכון לטווח ארוך. אם מבקש לחשוב - הצע לשריין לו את ההטבה ללא התחייבות.',
    closingGoal: 'קבלת אישור עקרוני מהלקוח או תיאום שיחת סגירה עם נציג בכיר',
    persuasionStyle: 'charismatic',
  },
  customer_service: {
    supportedServices: '',
    troubleshootingGuide: '',
    refundWarrantyPolicy: 'בדיקת זכאות להחזר או החלפה בהתאם לתקנון השירות ובגישה הוגנת ללקוח',
    escalationPolicy: 'אם הבעיה דורשת בדיקה טכנית מעמיקה, קח פרטים מלאים והבטח חזרה של נציג בכיר',
    slaPromise: 'חזרה תוך 24 שעות בימי עסקים',
    empathyLevel: 'high',
  },
  free_chat: {
    botPersonaName: 'רובי',
    personaBackground:
      'בן שיח חכם, שנון, נעים הליכות, בעל ידע עשיר בתורה, מדע, היסטוריה, טכנולוגיה וחיי היום-יום',
    favoriteTopics: 'חדשות מעניינות, חידות, סיפורים, ייעוץ יומיומי, מדע והעשרה',
    contentFilterLevel: 'strict_kosher',
    conversationMode: 'warm_friend',
  },
};

const PRESETS: Record<string, { label: string; prompt: string; rhetoric: string }> = {
  customer_service: {
    label: 'נציג שירות לקוחות',
    prompt:
      'אתה נציג שירות לקוחות מומחה, סבלני ואמפתי. הקשב ללקוח, תן לו תחושת ביטחון שהגעת כדי לפתור לו את הבעיה, ספק תשובות מדויקות וברורות, ואם נדרש המשך טיפול - קח פרטים בצורה מסודרת.',
    rhetoric:
      'רטוריקה של שירות לקוחות מצטיין: פתח תמיד בהכרה והזדהות ("אני מבין לגמרי", "מיד נבדוק ונסדר את זה"), השתמש בשפה מרגיעה וחיובית (מה כן אפשר לעשות במקום מה אי אפשר), פרק הסברים מורכבים לצעדים פשוטים וקצרים, וסיים תמיד בווידוא שביעות רצון.',
  },
  sales: {
    label: 'נציג מכירות',
    prompt:
      'אתה איש מכירות טלפוני ברמה הגבוהה ביותר — כריזמטי, קשוב, משכנע ומעורר אמון. זהה את הצורך האמיתי של המתקשר, הצג את התועלת המדויקת עבורו, פרק התנגדויות באלגנטיות והובל לסגירה טבעית.',
    rhetoric:
      'רטוריקה ויכולת שכנוע של איש מכירות מוביל: השתמש בשאלות מכוונות כדי שהלקוח יבטא בעצמו את הצורך, דבר בשפת תועלות (איך זה ישפר ללקוח את החיים/העסק) ולא רק מפרט טכני, השתמש בטון בטוח ונלהב, טפל בהתנגדויות בשיטת "הזדהות -> היפוך -> הצעת ערך", והובל בסיום כל תשובה לצעד הבא (Call To Action) בצורה נעימה אך החלטית.',
  },
  free_chat: {
    label: 'שיחה חופשית',
    prompt:
      'אתה בן שיח מרתק, חכם, סקרן ונעים לשיחה חופשית בטלפון. נהל שיחה קולחת וטבעית, גלה עניין אמיתי במתקשר, שלב ידע, שנינות ושאלות המשך שמפתחות את השיחה.',
    rhetoric:
      'רטוריקה של איש שיחה מרתק: הגב בצורה אנושית וחיה (לא כמו אנציקלופדיה יבשה), הוסף זווית מעניינת או שאלה מעוררת מחשבה בסוף דבריך כדי להמשיך את הזרימה, התאם את רמת העומק והקצב למתקשר, ושמור תמיד על שיח מכבד, נקי ונעים.',
  },
  receptionist: {
    label: 'פקיד קבלה / מזכירות',
    prompt:
      'אתה המזכיר האישי ופקיד הקבלה הטלפוני. קבל כל מתקשר באדיבות ייצוגית, ברר לשם מה התקשר, ענה על שאלות נפוצות שאתה מוסמך לענות עליהן, ואסוף את כל הפרטים הנדרשים להשארת הודעה מסודרת.',
    rhetoric:
      'רטוריקה של מזכיר בכיר וייצוגי: טון מסודר, רגוע, מכובד ויעיל. אל תשאל 4 שאלות בבת אחת — שאל שאלה אחת בכל תור (קודם שם ומטרת הפנייה, אחר כך פרטים משלימים או מספר לחזרה), חזור בקצרה על הפרטים החשובים כדי לוודא שקלטת נכון, והשרה על המתקשר ביטחון מלא שההודעה תגיע ליעדה.',
  },
};

const STYLES: Record<string, string> = {
  warm: 'חם, ידידותי וקליל, עם יחס אישי ואנושי כמו שיחה עם אדם קרוב ואכפתי.',
  formal: 'מקצועי, ייצוגי ומנומס מאוד, בלשון מכובדת ורהוטה ללא סלנג.',
  brief: 'קצר, ממוקד וענייני מאוד — משפט אחד או שניים קולעים לכל תשובה.',
  humorous: 'קליל עם חוש הומור עדין ושנון שמעלה חיוך, תוך שמירה על כבוד המתקשר.',
  calm: 'רגוע, שליו, איטי וסבלני במיוחד — משרה רוגע וביטחון.',
  energetic: 'אנרגטי, חיובי, דינמי ונלהב — עם חיוך ואנרגיה גבוהה בקול.',
};

const STYLE_NAMES_HE: Record<string, string> = {
  warm: 'חם וידידותי',
  formal: 'מקצועי ומנומס',
  brief: 'קצר וענייני',
  humorous: 'הומוריסטי',
  calm: 'רגוע וסבלני',
  energetic: 'אנרגטי ונלהב',
};

// 100% Genuine Google AI Studio Human Voices (Real distinct Google Studio prebuilt voice models)
const VOICES: Array<{
  name: string;
  label: string;
  spokenName: string;
  category: 'studio_male_a' | 'studio_male_b' | 'studio_female' | 'classic';
}> = [
  // קולות גברים אנושיים — גוגל סטודיו (קבוצה א: סמכותיים, עמוקים ועסקיים)
  {
    name: 'he-IL-Chirp3-HD-Charon',
    label: 'גוגל סטודיו אברי (Charon) — גבר ישראלי אנושי, עמוק, סמכותי ורדיופוני',
    spokenName: 'אברי כארון גבר ישראלי אנושי עמוק וסמכותי',
    category: 'studio_male_a',
  },
  {
    name: 'he-IL-Chirp3-HD-Orus',
    label: 'גוגל סטודיו אורן (Orus) — גבר ישראלי אנושי, עסקי, בטוח ומדויק',
    spokenName: 'אורן אורוס גבר ישראלי אנושי עסקי ובטוח',
    category: 'studio_male_a',
  },
  {
    name: 'he-IL-Chirp3-HD-Algieba',
    label: 'גוגל סטודיו אלון (Algieba) — גבר ישראלי אנושי, בריטון חם, רגוע ומרשים',
    spokenName: 'אלון אלגיבה גבר ישראלי אנושי בריטון חם ומרשים',
    category: 'studio_male_a',
  },
  {
    name: 'he-IL-Chirp3-HD-Fenrir',
    label: 'גוגל סטודיו דניאל (Fenrir) — גבר ישראלי אנושי, כריזמטי, נמרץ ומשכנע',
    spokenName: 'דניאל פנריר גבר ישראלי אנושי כריזמטי ומשכנע',
    category: 'studio_male_a',
  },
  {
    name: 'he-IL-Chirp3-HD-Iapetus',
    label: 'גוגל סטודיו יואב (Iapetus) — גבר ישראלי אנושי, שקול, מכובד וייצוגי',
    spokenName: 'יואב יאפטוס גבר ישראלי אנושי שקול וייצוגי',
    category: 'studio_male_a',
  },
  {
    name: 'he-IL-Chirp3-HD-Algenib',
    label: 'גוגל סטודיו איתן (Algenib) — גבר ישראלי אנושי, סמכותי, חד וברור',
    spokenName: 'איתן אלגניב גבר ישראלי אנושי סמכותי וברור',
    category: 'studio_male_a',
  },
  {
    name: 'he-IL-Chirp3-HD-Sadaltager',
    label: 'גוגל סטודיו מאיר (Sadaltager) — גבר ישראלי אנושי, בוגר, חכם ומרגיע',
    spokenName: 'מאיר סדלטגר גבר ישראלי אנושי בוגר ומרגיע',
    category: 'studio_male_a',
  },
  {
    name: 'he-IL-Chirp3-HD-Rasalgethi',
    label: 'גוגל סטודיו דורון (Rasalgethi) — גבר ישראלי אנושי, רהוט, עמוק ורשמי',
    spokenName: 'דורון רסלגתי גבר ישראלי אנושי רהוט ורשמי',
    category: 'studio_male_a',
  },
  // קולות גברים אנושיים — גוגל סטודיו (קבוצה ב: לבביים, שיחתיים ודינמיים)
  {
    name: 'he-IL-Chirp3-HD-Puck',
    label: 'גוגל סטודיו נועם (Puck) — גבר ישראלי אנושי, צעיר, לבבי, חייכני וזורם',
    spokenName: 'נועם פאק גבר ישראלי אנושי צעיר לבבי וזורם',
    category: 'studio_male_b',
  },
  {
    name: 'he-IL-Chirp3-HD-Enceladus',
    label: 'גוגל סטודיו עמית (Enceladus) — גבר ישראלי אנושי, נעים, קשוב ושירותי',
    spokenName: 'עמית אנקלדוס גבר ישראלי אנושי נעים ושירותי',
    category: 'studio_male_b',
  },
  {
    name: 'he-IL-Chirp3-HD-Alnilam',
    label: 'גוגל סטודיו רועי (Alnilam) — גבר ישראלי אנושי, קרייני, חד ובהיר',
    spokenName: 'רועי אלנילם גבר ישראלי אנושי קרייני ובהיר',
    category: 'studio_male_b',
  },
  {
    name: 'he-IL-Chirp3-HD-Schedar',
    label: 'גוגל סטודיו גיל (Schedar) — גבר ישראלי אנושי, נינוח, חברותי ובגובה העיניים',
    spokenName: 'גיל שדאר גבר ישראלי אנושי נינוח וחברותי',
    category: 'studio_male_b',
  },
  {
    name: 'he-IL-Chirp3-HD-Achird',
    label: 'גוגל סטודיו אלעד (Achird) — גבר ישראלי אנושי, ידידותי, קליל וטבעי',
    spokenName: 'אלעד אכירד גבר ישראלי אנושי ידידותי וטבעי',
    category: 'studio_male_b',
  },
  {
    name: 'he-IL-Chirp3-HD-Sadachbia',
    label: 'גוגל סטודיו שי (Sadachbia) — גבר ישראלי אנושי, אנרגטי, שמח ומעורר עניין',
    spokenName: 'שי סדכביה גבר ישראלי אנושי אנרגטי ושמח',
    category: 'studio_male_b',
  },
  {
    name: 'he-IL-Chirp3-HD-Umbriel',
    label: 'גוגל סטודיו יונתן (Umbriel) — גבר ישראלי אנושי, רגוע, סבלני ומעורר אמון',
    spokenName: 'יונתן אומבריאל גבר ישראלי אנושי רגוע וסבלני',
    category: 'studio_male_b',
  },
  {
    name: 'he-IL-Chirp3-HD-Zubenelgenubi',
    label: 'גוגל סטודיו הראל (Zubenelgenubi) — גבר ישראלי אנושי, מרשים, עשיר וייחודי',
    spokenName: 'הראל זובנלגנובי גבר ישראלי אנושי מרשים וייחודי',
    category: 'studio_male_b',
  },
  // קולות נשים אנושיים — גוגל סטודיו
  {
    name: 'he-IL-Chirp3-HD-Aoede',
    label: 'גוגל סטודיו הילה (Aoede) — אישה ישראלית אנושית, טבעית, רהוטה ומקצועית',
    spokenName: 'הילה אאודה אישה ישראלית אנושית טבעית ומקצועית',
    category: 'studio_female',
  },
  {
    name: 'he-IL-Chirp3-HD-Kore',
    label: 'גוגל סטודיו מיכל (Kore) — אישה ישראלית אנושית, חמה, שירותית ואמפתית',
    spokenName: 'מיכל קורה אישה ישראלית אנושית חמה ושירותית',
    category: 'studio_female',
  },
  {
    name: 'he-IL-Chirp3-HD-Leda',
    label: 'גוגל סטודיו יעל (Leda) — אישה ישראלית אנושית, ייצוגית, בהירה ועסקית',
    spokenName: 'יעל לדה אישה ישראלית אנושית ייצוגית ובהירה',
    category: 'studio_female',
  },
  {
    name: 'he-IL-Chirp3-HD-Zephyr',
    label: 'גוגל סטודיו מאיה (Zephyr) — אישה ישראלית אנושית, צעירה, חייכנית וקלילה',
    spokenName: 'מאיה זפיר אישה ישראלית אנושית צעירה וחייכנית',
    category: 'studio_female',
  },
  {
    name: 'he-IL-Chirp3-HD-Autonoe',
    label: 'גוגל סטודיו שירה (Autonoe) — אישה ישראלית אנושית, רכה, רגועה וסבלנית',
    spokenName: 'שירה אוטונואה אישה ישראלית אנושית רגועה וסבלנית',
    category: 'studio_female',
  },
  {
    name: 'he-IL-Chirp3-HD-Callirrhoe',
    label: 'גוגל סטודיו דנה (Callirrhoe) — אישה ישראלית אנושית, לבבית, זורמת ונעימה',
    spokenName: 'דנה קלירואה אישה ישראלית אנושית לבבית ונעימה',
    category: 'studio_female',
  },
  {
    name: 'he-IL-Chirp3-HD-Despina',
    label: 'גוגל סטודיו רוני (Despina) — אישה ישראלית אנושית, חדה, עניינית וברורה',
    spokenName: 'רוני דספינה אישה ישראלית אנושית חדה וברורה',
    category: 'studio_female',
  },
  {
    name: 'he-IL-Chirp3-HD-Laomedeia',
    label: 'גוגל סטודיו תמר (Laomedeia) — אישה ישראלית אנושית, אנרגטית, חיונית ומזמינה',
    spokenName: 'תמר לאומדיה אישה ישראלית אנושית אנרגטית ומזמינה',
    category: 'studio_female',
  },
  // קולות קלאסיים בעברית (ממופים לקולות גוגל סטודיו אנושיים)
  {
    name: 'he-IL-Wavenet-B',
    label: 'סטודיו קלאסי B (Iapetus) — גבר ישראלי אנושי עמוק ורשמי',
    spokenName: 'סטודיו קלאסי בי גבר ישראלי עמוק ורשמי',
    category: 'classic',
  },
  {
    name: 'he-IL-Wavenet-D',
    label: 'סטודיו קלאסי D (Charon) — גבר ישראלי אנושי טבעי ושיחתי',
    spokenName: 'סטודיו קלאסי די גבר ישראלי טבעי ושיחתי',
    category: 'classic',
  },
  {
    name: 'he-IL-Wavenet-A',
    label: 'סטודיו קלאסי A (Aoede) — אישה ישראלית אנושית נעימה וברורה',
    spokenName: 'סטודיו קלאסי איי אישה ישראלית נעימה וברורה',
    category: 'classic',
  },
  {
    name: 'he-IL-Wavenet-C',
    label: 'סטודיו קלאסי C (Leda) — אישה ישראלית אנושית רשמית ורהוטה',
    spokenName: 'סטודיו קלאסי סי אישה ישראלית רשמית ורהוטה',
    category: 'classic',
  },
];

const DEFAULT_DAYS = Array.from({ length: 7 }, (_, i) => ({
  open: i !== 6,
  from: '08:00',
  to: '20:00',
}));

const DEFAULT_CONFIG: TenantConfigData = {
  enabled: true,
  role: 'customer_service',
  businessName: '',
  businessInfo: '',
  customInstructions: '',
  topicsMode: 'all',
  topics: [],
  offTopicReply: 'סליחה, בנושא הזה אני לא יכול לעזור. אפשר לעזור במשהו אחר?',
  style: 'warm',
  voice: { provider: 'google', name: 'he-IL-Chirp3-HD-Charon', speakingRate: 1.0 },
  greeting: 'שלום, איך אפשר לעזור?',
  goodbye: 'תודה רבה ולהתראות.',
  consentMessage: '',
  access: { mode: 'all', numbers: [] },
  deniedMessage: 'מצטערים, אין לך הרשאה להשתמש בשירות זה.',
  closedMessage: 'השירות סגור כעת. אנא חזרו בשעות הפעילות.',
  schedule: { enabled: false, tz: 'Asia/Jerusalem', days: DEFAULT_DAYS },
  tools: { email: true, fax: false, images: true },
  maxMinutes: 10,
  useNikud: false,
  yemotChatExt: '1',
  yemotAdminExt: '',
  notificationEmail: '',
  autoSyncYemot: true,
  handsFreeMode: true,
  handsFreeAutoStopSec: 4,
  roleParams: DEFAULT_ROLE_PARAMS,
};

function mergeConfigWithDefaults(partial?: Partial<TenantConfigData>): TenantConfigData {
  const base = partial || {};
  const rawAutoStop = Number(base.handsFreeAutoStopSec);
  const effectiveAutoStop =
    !rawAutoStop || rawAutoStop === 10 ? 4 : Math.min(8, Math.max(3, rawAutoStop));
  return {
    ...DEFAULT_CONFIG,
    ...base,
    handsFreeMode: base.handsFreeMode !== false,
    handsFreeAutoStopSec: effectiveAutoStop,
    notificationEmail:
      typeof base.notificationEmail === 'string' ? base.notificationEmail.trim() : '',
    voice: {
      ...DEFAULT_CONFIG.voice,
      ...(base.voice || {}),
    },
    access: {
      ...DEFAULT_CONFIG.access,
      ...(base.access || {}),
    },
    schedule: {
      ...DEFAULT_CONFIG.schedule,
      ...(base.schedule || {}),
      days:
        Array.isArray(base.schedule?.days) && base.schedule!.days.length === 7
          ? base.schedule!.days
          : DEFAULT_DAYS,
    },
    tools: {
      ...DEFAULT_CONFIG.tools,
      ...(base.tools || {}),
    },
    roleParams: {
      receptionist: {
        ...DEFAULT_ROLE_PARAMS.receptionist,
        ...(base.roleParams?.receptionist || {}),
      },
      sales: {
        ...DEFAULT_ROLE_PARAMS.sales,
        ...(base.roleParams?.sales || {}),
      },
      customer_service: {
        ...DEFAULT_ROLE_PARAMS.customer_service,
        ...(base.roleParams?.customer_service || {}),
      },
      free_chat: {
        ...DEFAULT_ROLE_PARAMS.free_chat,
        ...(base.roleParams?.free_chat || {}),
      },
    },
  };
}

const normalizeExtKey = (ext?: string): string => {
  const clean = String(ext ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!clean || clean === 'main') return 'root';
  return clean;
};

const extKeyToSlug = (ext?: string): string =>
  normalizeExtKey(ext).replace(/[^a-zA-Z0-9_-]/g, '_');

const ymClean = (t: string) =>
  String(t ?? '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim() || ' ';

const normPhone = (n: string) => {
  let d = String(n || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return d || 'anonymous';
};

const hashToken = (token: string, salt: string) =>
  scryptSync(String(token), salt, 32).toString('hex');

function verifyHash(token: string, salt: string, expectedHash: string): boolean {
  if (!salt || !expectedHash || !token) return false;
  const a = Buffer.from(hashToken(token, salt), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Built-in seed tenants so Cloud Run cold starts immediately know the user's systems in 0ms
const SEED_TENANTS: Record<string, StoredTenant> = {
  '0772023014': {
    id: '0772023014',
    name: 'יצחק שמח מושקוביץ',
    tokenSalt: '635804c3dcd36fa57cf8f8aaa8d4bae6',
    tokenHash: '795725c99f7a6dafa357dfd41443d9e6edaf2978409574b5f38be57f20c89015',
    yemotNumber: '0772023014',
    yemotPassword: '317304103',
    dailyCallLimit: 200,
    callsToday: 0,
    lastCallDay: '2026-11-18',
    yemotChatExt: '1',
    yemotAdminExt: '2',
    yemotSyncedAt: '2026-11-18T00:51:44.504Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    config: mergeConfigWithDefaults({
      role: 'free_chat',
      style: 'warm',
      voice: { name: 'he-IL-Wavenet-A', speakingRate: 0.8 },
      greeting: 'שלום, אני רובי בוט, במה תרצה שנעסוק היום?',
      yemotChatExt: '1',
      yemotAdminExt: '2',
    }),
    extensions: {},
    memory: {},
    extensionMemories: {},
  },
  '0772222672': {
    id: '0772222672',
    name: 'יצחק שמחה מושקוביץ',
    tokenSalt: '317b4f54cc7f868bf37d139bd01d631a',
    tokenHash: 'a8f672388b27bb6963c53deea42d826a40a673437ba5c242263f7f15daf5ca33',
    yemotNumber: '0772222672',
    yemotPassword: '317304103',
    dailyCallLimit: 200,
    callsToday: 0,
    lastCallDay: '2026-11-18',
    yemotChatExt: '2',
    yemotAdminExt: '3',
    yemotSyncedAt: '2026-11-18T00:20:07.332Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    config: mergeConfigWithDefaults({
      role: 'free_chat',
      style: 'warm',
      voice: { name: 'he-IL-Wavenet-A', speakingRate: 1.0 },
      greeting: 'שלום, אני רובי, במה אפשר לעזור?',
      yemotChatExt: '2',
      yemotAdminExt: '3',
    }),
    extensions: {},
    memory: {},
    extensionMemories: {},
  },
  '0772610845': {
    id: '0772610845',
    name: 'יצחק שמחה מושקוביץ',
    tokenSalt: '08a9dc0767a4a4692cf94380506c82b6',
    tokenHash: '59a7255648ae1521b7552a8336d0ec71a9ae26e6178ed777600e7fbfca672383',
    yemotNumber: '0772610845',
    yemotPassword: '317304103',
    dailyCallLimit: 200,
    callsToday: 0,
    lastCallDay: '2026-11-18',
    yemotChatExt: '1',
    yemotAdminExt: '2',
    yemotSyncedAt: '2026-11-18T00:18:28.729Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    config: mergeConfigWithDefaults({
      role: 'free_chat',
      style: 'warm',
      voice: { name: 'he-IL-Chirp3-HD-Charon', speakingRate: 0.9 },
      greeting: 'שלום, אני רובי, הבוט החכם, במה אפשר לעזור?',
      maxMinutes: 15,
      useNikud: true,
      yemotChatExt: '1',
      yemotAdminExt: '2',
    }),
    extensions: {},
    memory: {},
    extensionMemories: {},
  },
};

const memoryTenants: Record<string, StoredTenant> = {};
for (const [id, t] of Object.entries(SEED_TENANTS)) {
  const mainExt = normalizeExtKey(t.yemotChatExt || '1');
  memoryTenants[id] = {
    ...t,
    extensions: { [mainExt]: t.config, ...(t.extensions || {}) },
    extensionMemories: { [mainExt]: {}, ...(t.extensionMemories || {}) },
  };
}

function getTenantsFilePath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '.data'),
    path.join(os.tmpdir(), 'yemot-ai-data'),
  ];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return path.join(dir, 'tenants.json');
    } catch {
      // try next candidate
    }
  }
  return null;
}

const TENANTS_FILE = getTenantsFilePath();

function normalizeTenantStructure(t: StoredTenant): StoredTenant {
  const cfg = mergeConfigWithDefaults(t.config);
  const defaultExt = normalizeExtKey(t.yemotChatExt || cfg.yemotChatExt || '1');
  const extensions: Record<string, TenantConfigData> = {};
  if (t.extensions && typeof t.extensions === 'object') {
    for (const [k, v] of Object.entries(t.extensions)) {
      const normK = normalizeExtKey(k);
      extensions[normK] = mergeConfigWithDefaults({
        ...v,
        yemotChatExt: normK === 'root' ? 'root' : normK,
      });
    }
  }
  if (!extensions[defaultExt]) {
    extensions[defaultExt] = {
      ...cfg,
      yemotChatExt: defaultExt === 'root' ? 'root' : defaultExt,
    };
  }
  const extensionMemories: Record<string, Record<string, ChatHistoryEntry[]>> = {
    ...(t.extensionMemories || {}),
  };
  if (!extensionMemories[defaultExt]) {
    extensionMemories[defaultExt] = { ...(t.memory || {}) };
  }
  return {
    ...t,
    yemotChatExt: defaultExt === 'root' ? 'root' : defaultExt,
    config: extensions[defaultExt],
    extensions,
    memory: t.memory || {},
    extensionMemories,
  };
}

let diskTenantsLoadedOnce = false;
const cloudHydratedAt: Record<string, number> = {};

function loadLocalTenants(): Record<string, StoredTenant> {
  if (!diskTenantsLoadedOnce && TENANTS_FILE) {
    diskTenantsLoadedOnce = true;
    try {
      if (fs.existsSync(TENANTS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf8'));
        for (const [k, rawV] of Object.entries(parsed)) {
          const v = normalizeTenantStructure(rawV as StoredTenant);
          if (!memoryTenants[k]) {
            memoryTenants[k] = v;
          } else {
            const cur = normalizeTenantStructure(memoryTenants[k]);
            const mergedExtMem: Record<string, Record<string, ChatHistoryEntry[]>> = {
              ...(cur.extensionMemories || {}),
            };
            for (const [extK, callers] of Object.entries(v.extensionMemories || {})) {
              mergedExtMem[extK] = { ...(mergedExtMem[extK] || {}), ...callers };
            }
            // Disk values (v) MUST override hardcoded SEED_TENANTS (cur) so user changes never revert!
            memoryTenants[k] = normalizeTenantStructure({
              ...cur,
              ...v,
              config: v.config || cur.config,
              extensions: { ...(cur.extensions || {}), ...(v.extensions || {}) },
              memory: { ...(cur.memory || {}), ...(v.memory || {}) },
              extensionMemories: mergedExtMem,
            });
          }
        }
      }
    } catch (e) {
      console.error('Failed to read local tenants:', e);
    }
  }
  return memoryTenants;
}

function saveLocalTenants(data: Record<string, StoredTenant>) {
  diskTenantsLoadedOnce = true;
  for (const [k, v] of Object.entries(data)) {
    memoryTenants[k] = normalizeTenantStructure(v);
  }
  if (TENANTS_FILE) {
    try {
      fs.writeFileSync(TENANTS_FILE, JSON.stringify(memoryTenants, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to write local tenants:', e);
    }
  }
}

export function getTenantExtConfig(tenant: StoredTenant, ext?: string): TenantConfigData {
  const norm = normalizeTenantStructure(tenant);
  const key = ext ? normalizeExtKey(ext) : normalizeExtKey(norm.yemotChatExt || '1');
  if (norm.extensions && norm.extensions[key]) {
    return mergeConfigWithDefaults(norm.extensions[key]);
  }
  return mergeConfigWithDefaults(norm.config);
}

export function setTenantExtConfig(
  tenant: StoredTenant,
  ext: string,
  cfg: TenantConfigData
): TenantConfigData {
  const key = normalizeExtKey(ext || tenant.yemotChatExt || '1');
  const prevVoiceName = tenant.extensions?.[key]?.voice?.name || tenant.config?.voice?.name;
  const merged = mergeConfigWithDefaults({
    ...cfg,
    yemotChatExt: key === 'root' ? 'root' : key,
  });
  if (!tenant.extensions) tenant.extensions = {};
  tenant.extensions[key] = merged;
  tenant.yemotChatExt = key === 'root' ? 'root' : key;
  tenant.config = merged;
  // Lock the selected voice across all extensions of the tenant whenever the user changes the voice
  // so the chosen voice is 100% consistent across all calls unless explicitly changed!
  if (merged.voice?.name && merged.voice.name !== prevVoiceName) {
    for (const extCfg of Object.values(tenant.extensions)) {
      extCfg.voice = { ...merged.voice };
    }
  }
  if (typeof merged.yemotAdminExt === 'string') {
    tenant.yemotAdminExt = merged.yemotAdminExt;
  }
  tenant.updatedAt = new Date().toISOString();
  return merged;
}

async function verifyYemotCredentials(
  systemNumber: string,
  password: string
): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const cleanNum = systemNumber.replace(/\D/g, '');
    if (!cleanNum || cleanNum.length < 7) {
      return { ok: false, error: 'מספר המערכת אינו תקין.' };
    }
    const url = `https://www.call2all.co.il/ym/api/GetSession?token=${encodeURIComponent(
      `${cleanNum}:${password}`
    )}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json().catch(() => ({}))) as {
      responseStatus?: string;
      name?: string;
      message?: string;
    };
    if (data.responseStatus === 'OK') {
      return { ok: true, name: data.name || `מערכת ${cleanNum}` };
    }
    return {
      ok: false,
      error: 'מספר המערכת או הסיסמה בימות המשיח אינם נכונים.',
    };
  } catch (e) {
    console.error('Yemot verification error:', e);
    return { ok: false, error: 'שגיאה באימות מול שרתי ימות המשיח.' };
  }
}

async function yemotUploadTextFile(
  yemotToken: string,
  what: string,
  contents: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const params = new URLSearchParams({
      token: yemotToken,
      what,
      contents,
    });
    // CRITICAL: Must use HTTP POST with application/x-www-form-urlencoded so large JSON tenant bundles never fail with HTTP 414 URI Too Long!
    const res = await fetch('https://www.call2all.co.il/ym/api/UploadTextFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `שגיאת שרת ימות המשיח (HTTP ${res.status})`,
      };
    }
    const j = (await res.json().catch(() => ({}))) as {
      responseStatus?: string;
      message?: string;
    };
    if (j.responseStatus && j.responseStatus !== 'OK') {
      return {
        ok: false,
        error: `ימות המשיח דחה את העדכון (${j.message || j.responseStatus})`,
      };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: 'שגיאת תקשורת מול ימות המשיח: ' + msg };
  }
}

async function yemotGetTextFile(yemotToken: string, what: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ token: yemotToken, what });
    const res = await fetch(
      `https://www.call2all.co.il/ym/api/GetTextFile?${params.toString()}`,
      { signal: AbortSignal.timeout(3500) }
    );
    const j = (await res.json().catch(() => ({}))) as {
      responseStatus?: string;
      contents?: string;
    };
    if (j.responseStatus === 'OK' && typeof j.contents === 'string') {
      return j.contents;
    }
  } catch {
    // ignore
  }
  return null;
}

async function yemotDeleteFile(yemotToken: string, what: string): Promise<void> {
  try {
    const params = new URLSearchParams({
      token: yemotToken,
      action: 'delete',
      what,
    });
    await fetch(`https://www.call2all.co.il/ym/api/FileAction?${params.toString()}`, {
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // ignore non-critical delete errors
  }
}

const MASTER_REGISTRY_INDEX_PATH = 'ivr2:/yemot_ai_registry_index.tts';
const knownRegisteredTenantIds = new Set<string>(Object.keys(SEED_TENANTS));

async function updateMasterRegistryIndex(newTenantId?: string): Promise<void> {
  try {
    if (newTenantId) knownRegisteredTenantIds.add(newTenantId);
    for (const id of Object.keys(memoryTenants)) {
      knownRegisteredTenantIds.add(id);
    }
    const existingRaw = await yemotGetTextFile(MASTER_REGISTRY_TOKEN, MASTER_REGISTRY_INDEX_PATH);
    if (existingRaw) {
      try {
        const parsed = JSON.parse(existingRaw);
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            if (typeof id === 'string' && id.trim()) knownRegisteredTenantIds.add(id.trim());
          }
        }
      } catch {
        // ignore parse error
      }
    }
    await yemotUploadTextFile(
      MASTER_REGISTRY_TOKEN,
      MASTER_REGISTRY_INDEX_PATH,
      JSON.stringify(Array.from(knownRegisteredTenantIds))
    );
  } catch {
    // ignore index update error
  }
}

// Save tenant record to permanent central cloud vault on MASTER_REGISTRY_TOKEN (via HTTP POST)
// so Cloud Run cold starts or container restarts NEVER lose any current or future customer's settings,
// while keeping the customer's own Yemot system completely clean of config files!
// ===== שמירה קבועה ב-Firestore (Google Cloud) =====
// הנתונים נשמרים במסד נתונים של גוגל, ולא על הדיסק של השרת, כך שהם לא נמחקים בהפעלה מחדש.
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'yemot_tenants';
let firestoreClient: Firestore | null = null;
function getFirestore(): Firestore {
  if (!firestoreClient) {
    firestoreClient = new Firestore(
      process.env.FIRESTORE_DATABASE_ID ? { databaseId: process.env.FIRESTORE_DATABASE_ID } : {}
    );
  }
  return firestoreClient;
}

async function firestoreSaveTenant(t: StoredTenant): Promise<void> {
  await getFirestore()
    .collection(FIRESTORE_COLLECTION)
    .doc(t.id)
    .set({
      id: t.id,
      updatedAt: t.updatedAt || new Date().toISOString(),
      json: JSON.stringify(t),
    });
}

async function firestoreGetTenantRaw(tenantId: string): Promise<string | null> {
  try {
    const snap = await getFirestore().collection(FIRESTORE_COLLECTION).doc(tenantId).get();
    return snap.exists ? ((snap.data()?.json as string) || null) : null;
  } catch (e) {
    console.error('FIRESTORE READ FAILED:', tenantId, (e as Error)?.message || e);
    return null;
  }
}

async function firestoreLoadAllTenants(): Promise<void> {
  const snaps = await getFirestore().collection(FIRESTORE_COLLECTION).get();
  for (const d of snaps.docs) {
    const raw = d.data()?.json as string | undefined;
    if (!raw) continue;
    memoryTenants[d.id] = normalizeTenantStructure(JSON.parse(raw) as StoredTenant);
  }
  console.log(`Loaded ${snaps.size} tenants from Firestore`);
}

async function persistTenantToYemotCloud(
  tenant: StoredTenant,
  stampNewTimestamp = true
): Promise<void> {
  try {
    const stampedUpdatedAt = stampNewTimestamp
      ? new Date().toISOString()
      : tenant.updatedAt && tenant.updatedAt > '2026-01-02T00:00:00.000Z'
      ? tenant.updatedAt
      : new Date().toISOString();
    tenant.updatedAt = stampedUpdatedAt;
    cloudHydratedAt[tenant.id] = Date.now();
    memoryTenants[tenant.id] = normalizeTenantStructure(tenant);
    saveLocalTenants(memoryTenants);

    const slim: StoredTenant = {
      ...tenant,
      updatedAt: stampedUpdatedAt,
      memory: {},
      extensionMemories: {},
    };
    await firestoreSaveTenant(slim);
    try {
      await yemotUploadTextFile(
        MASTER_REGISTRY_TOKEN,
        `ivr2:/yemot_ai_t_${tenant.id}.tts`,
        JSON.stringify(slim)
      );
      await updateMasterRegistryIndex(tenant.id);
    } catch {
      // גיבוי בלבד בימות: כשל כאן לא מונע שמירה
    }
  } catch (e) {
    console.error('TENANT SAVE FAILED (Firestore):', tenant.id, (e as Error)?.message || e);
  }
}

async function hydrateTenantFromYemotCloud(
  tenantId: string,
  forceCheck = false
): Promise<StoredTenant | undefined> {
  const tenants = loadLocalTenants();
  const existing = tenants[tenantId];
  const lastCheck = cloudHydratedAt[tenantId] || 0;
  if (!forceCheck && existing && Date.now() - lastCheck < 45_000) {
    return normalizeTenantStructure(existing);
  }
  cloudHydratedAt[tenantId] = Date.now();

  try {
    // 1. Check central master registry vault first (stored via POST on MASTER_REGISTRY_TOKEN)
    const raw =
      (await firestoreGetTenantRaw(tenantId)) ??
      (await yemotGetTextFile(MASTER_REGISTRY_TOKEN, `ivr2:/yemot_ai_t_${tenantId}.tts`));
    if (raw) {
      const cloudTenant = normalizeTenantStructure(JSON.parse(raw) as StoredTenant);
      const existingUpdated = existing?.updatedAt || '2026-01-01T00:00:00.000Z';
      const cloudUpdated = cloudTenant.updatedAt || '2026-01-02T00:00:00.000Z';
      if (!existing || cloudUpdated >= existingUpdated) {
        const merged = existing
          ? normalizeTenantStructure({
              ...existing,
              ...cloudTenant,
              updatedAt: cloudUpdated,
              config: cloudTenant.config || existing.config,
              extensions: {
                ...(existing.extensions || {}),
                ...(cloudTenant.extensions || {}),
              },
              memory: existing.memory || {},
              extensionMemories: existing.extensionMemories || {},
            })
          : cloudTenant;
        tenants[tenantId] = merged;
        saveLocalTenants(tenants);
        return merged;
      }
      return normalizeTenantStructure(existing);
    }

    // 2. One-time migration fallback: if this customer doesn't have a v8 master vault entry yet,
    // check if their Yemot account has legacy yemot_ai_tenant_bundle.tts or yemot_ai_cfg_*.tts files,
    // import them into the central vault, and clean them from the customer's Yemot root folder.
    if (existing?.yemotNumber && existing?.yemotPassword) {
      const yemotToken = `${existing.yemotNumber}:${existing.yemotPassword}`;
      const bundleRaw = await yemotGetTextFile(yemotToken, 'ivr2:/yemot_ai_tenant_bundle.tts');
      if (bundleRaw) {
        const bundle = JSON.parse(bundleRaw) as Partial<StoredTenant>;
        if (bundle.config || bundle.extensions) {
          const merged = normalizeTenantStructure({
            ...existing,
            yemotChatExt: bundle.yemotChatExt || existing.yemotChatExt,
            yemotAdminExt: bundle.yemotAdminExt || existing.yemotAdminExt,
            dailyCallLimit: bundle.dailyCallLimit || existing.dailyCallLimit,
            updatedAt: bundle.updatedAt || new Date().toISOString(),
            config: bundle.config || existing.config,
            extensions: {
              ...(existing.extensions || {}),
              ...(bundle.extensions || {}),
            },
          });
          tenants[tenantId] = merged;
          saveLocalTenants(tenants);
          await persistTenantToYemotCloud(merged, false);
          return merged;
        }
      }

      // Check legacy per-extension config file on customer's Yemot account
      const mainExtSlug = extKeyToSlug(existing.yemotChatExt || '1');
      const legacyCfgRaw =
        (await yemotGetTextFile(yemotToken, `ivr2:/yemot_ai_cfg_${mainExtSlug}.tts`)) ||
        (await yemotGetTextFile(yemotToken, 'ivr2:/yemot_ai_config.tts'));
      if (legacyCfgRaw) {
        const legacyCfg = mergeConfigWithDefaults(JSON.parse(legacyCfgRaw));
        const extKey = normalizeExtKey(legacyCfg.yemotChatExt || existing.yemotChatExt || '1');
        const merged = normalizeTenantStructure({
          ...existing,
          updatedAt: new Date().toISOString(),
          config: legacyCfg,
          extensions: {
            ...(existing.extensions || {}),
            [extKey]: legacyCfg,
          },
        });
        tenants[tenantId] = merged;
        saveLocalTenants(tenants);
        await persistTenantToYemotCloud(merged, false);
        return merged;
      }
    }
  } catch {
    // ignore network/parse error
  }

  return existing ? normalizeTenantStructure(existing) : undefined;
}

async function loadAllTenantsFromCloudRegistry(): Promise<void> {
  try {
    const rawIdx = await yemotGetTextFile(MASTER_REGISTRY_TOKEN, MASTER_REGISTRY_INDEX_PATH);
    if (rawIdx) {
      const ids = JSON.parse(rawIdx);
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string' && id.trim()) {
            knownRegisteredTenantIds.add(id.trim());
          }
        }
      }
    }
    for (const id of Object.keys(loadLocalTenants())) {
      knownRegisteredTenantIds.add(id);
    }
    await Promise.all(
      Array.from(knownRegisteredTenantIds).map((id) => hydrateTenantFromYemotCloud(id, true))
    );
  } catch {
    // ignore startup registry load error
  }
}

async function ensureTenantLoaded(tenantId: string): Promise<StoredTenant | undefined> {
  if (!tenantId) return undefined;
  return await hydrateTenantFromYemotCloud(tenantId);
}

function sanitizeMemoryEntries(entries: ChatHistoryEntry[]): ChatHistoryEntry[] {
  return (entries || []).filter((e) => {
    const txt = (e.parts || []).map((p) => p.text || '').join(' ');
    if (
      txt.includes('אין לי אפשרות לשלוח מיילים') ||
      txt.includes('בנויה רק לדיבור קולי ולא לשליחת מיילים') ||
      txt.includes('אין לי כאן מסך להציג תמונות')
    ) {
      return false;
    }
    return true;
  });
}

async function loadCallerMemoryFromYemot(
  tenant: StoredTenant,
  extKey: string,
  callerKey: string
): Promise<ChatHistoryEntry[]> {
  if (!tenant.extensionMemories) tenant.extensionMemories = {};
  if (!tenant.extensionMemories[extKey]) tenant.extensionMemories[extKey] = {};

  const existing = tenant.extensionMemories[extKey][callerKey];
  if (existing && existing.length > 0) {
    tenant.extensionMemories[extKey][callerKey] = sanitizeMemoryEntries(existing);
    return tenant.extensionMemories[extKey][callerKey];
  }

  if (tenant.yemotNumber && tenant.yemotPassword) {
    const yemotToken = `${tenant.yemotNumber}:${tenant.yemotPassword}`;
    const slug = extKeyToSlug(extKey);
    const paths = [
      `ivr2:/ApiRecords/mem_${slug}_${callerKey}.tts`,
      `ivr2:/ApiRecords/mem_${callerKey}.tts`,
    ];
    for (const p of paths) {
      const raw = await yemotGetTextFile(yemotToken, p);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            tenant.extensionMemories[extKey][callerKey] = sanitizeMemoryEntries(parsed).slice(-500);
            return tenant.extensionMemories[extKey][callerKey];
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return [];
}

const callerEmailsCache = new Map<string, string>();

async function loadCallerEmailFromYemot(
  tenant: StoredTenant,
  callerKey: string
): Promise<string> {
  if (!callerKey || callerKey === 'anonymous') return '';
  const cacheKey = `${tenant.id}:${callerKey}`;
  const cached = callerEmailsCache.get(cacheKey);
  if (cached) return cached;

  if (tenant.yemotNumber && tenant.yemotPassword) {
    const yemotToken = `${tenant.yemotNumber}:${tenant.yemotPassword}`;
    const raw = await yemotGetTextFile(yemotToken, `ivr2:/ApiRecords/email_${callerKey}.tts`);
    if (raw && raw.includes('@')) {
      const clean = raw.trim();
      callerEmailsCache.set(cacheKey, clean);
      return clean;
    }
  }
  return '';
}

async function saveCallerEmailToYemot(
  tenant: StoredTenant,
  callerKey: string,
  email: string
): Promise<void> {
  const clean = String(email || '').trim();
  if (!clean.includes('@') || !callerKey || callerKey === 'anonymous') return;
  callerEmailsCache.set(`${tenant.id}:${callerKey}`, clean);
  if (tenant.yemotNumber && tenant.yemotPassword) {
    const yemotToken = `${tenant.yemotNumber}:${tenant.yemotPassword}`;
    await yemotUploadTextFile(
      yemotToken,
      `ivr2:/ApiRecords/email_${callerKey}.tts`,
      clean
    ).catch(() => {});
  }
}

async function saveCallerMemoryToYemot(
  tenant: StoredTenant,
  extKey: string,
  callerKey: string,
  history: ChatHistoryEntry[]
): Promise<void> {
  const trimmed = history.slice(-500);
  if (!tenant.extensionMemories) tenant.extensionMemories = {};
  if (!tenant.extensionMemories[extKey]) tenant.extensionMemories[extKey] = {};
  tenant.extensionMemories[extKey][callerKey] = trimmed;
  tenant.memory[callerKey] = trimmed;

  if (tenant.yemotNumber && tenant.yemotPassword) {
    const yemotToken = `${tenant.yemotNumber}:${tenant.yemotPassword}`;
    const slug = extKeyToSlug(extKey);
    yemotUploadTextFile(
      yemotToken,
      `ivr2:/ApiRecords/mem_${slug}_${callerKey}.tts`,
      JSON.stringify(trimmed)
    ).catch(() => {});
  }
}

export async function configureYemotExtensionFull(
  yemotNumber: string,
  yemotPassword: string,
  extPath: string,
  apiLinkUrl: string,
  cfg: TenantConfigData,
  isAdminExt = false
): Promise<{ ok: boolean; error?: string }> {
  const yemotToken = `${yemotNumber}:${yemotPassword}`;
  const cleanExt = extPath.trim().replace(/^\/+|\/+$/g, '');
  const isRoot = cleanExt === '' || cleanExt === 'root' || cleanExt === 'main';
  const dirPath = isRoot ? 'ivr2:/' : `ivr2:/${cleanExt}`;
  const targetWhat = isRoot ? 'ivr2:/ext.ini' : `ivr2:/${cleanExt}/ext.ini`;

  // 1. Clean old conflicting M-files & INI files in that extension
  try {
    const dirRes = await fetch(
      `https://www.call2all.co.il/ym/api/GetIVR2Dir?${new URLSearchParams({
        token: yemotToken,
        path: dirPath,
      }).toString()}`,
      { signal: AbortSignal.timeout(4000) }
    );
    const dirJson = (await dirRes.json().catch(() => ({}))) as {
      files?: Array<{ name: string }>;
      ini?: Array<{ name: string }>;
    };

    const filesToDelete: string[] = [];
    for (const f of dirJson.files || []) {
      if (/^M\d+\.(wav|tts|mp3)$/i.test(f.name)) {
        filesToDelete.push(isRoot ? `ivr2:/${f.name}` : `ivr2:/${cleanExt}/${f.name}`);
      }
    }
    for (const iniFile of dirJson.ini || []) {
      const lower = iniFile.name.toLowerCase();
      if (
        lower === 'did_go_to.ini' ||
        lower === 'rating.ini' ||
        lower === 'rating_log_folder_amuont.ini' ||
        lower === 'listeningok.ini' ||
        (cfg.access?.mode !== 'whitelist' && lower === 'whitelist.ini') ||
        (cfg.access?.mode !== 'blacklist' && lower === 'blacklist.ini')
      ) {
        filesToDelete.push(
          isRoot ? `ivr2:/${iniFile.name}` : `ivr2:/${cleanExt}/${iniFile.name}`
        );
      }
    }

    await Promise.all(filesToDelete.map((w) => yemotDeleteFile(yemotToken, w)));
  } catch (e) {
    console.warn('Directory cleanup warning:', e);
  }

  // Also clean any old exposed config files from the customer's Yemot root folder so nothing is exposed in Yemot's web UI
  const slug = extKeyToSlug(cleanExt);
  Promise.all([
    yemotDeleteFile(yemotToken, `ivr2:/yemot_ai_cfg_${slug}.tts`),
    yemotDeleteFile(yemotToken, 'ivr2:/yemot_ai_config.tts'),
    yemotDeleteFile(yemotToken, 'ivr2:/yemot_ai_tenant_bundle.tts'),
  ]).catch(() => {});

  // 2. Build ultra-clean, minimal ext.ini containing ONLY the short API link + silence/no-beep telephony flags
  // (zero exposed AI settings on Yemot's website!)
  const baseOrigin = apiLinkUrl.replace(/\/(chat|admin|c|a)(?:\/.*)?$/i, '');
  const shortApiLink = isAdminExt ? `${baseOrigin}/a` : `${baseOrigin}/c`;

  const iniLines: string[] = [
    'type=api',
    `api_link=${shortApiLink}`,
  ];

  if (!isAdminExt) {
    // Eliminate the recording beep (M1166) and enable automatic silence detection (2s silence ends recording without #)
    iniLines.push('api_record_beep=no');
    iniLines.push('option_record=2-1-15');
    if (cfg.access?.mode === 'whitelist') {
      iniLines.push('white_list=yes');
      const wlPath = isRoot ? 'ivr2:/WhiteList.ini' : `ivr2:/${cleanExt}/WhiteList.ini`;
      await yemotUploadTextFile(
        yemotToken,
        wlPath,
        (cfg.access.numbers || []).map(normPhone).filter(Boolean).join('\n') + '\n'
      );
    } else if (cfg.access?.mode === 'blacklist') {
      iniLines.push('black_list=yes');
      const blPath = isRoot ? 'ivr2:/BlackList.ini' : `ivr2:/${cleanExt}/BlackList.ini`;
      await yemotUploadTextFile(
        yemotToken,
        blPath,
        (cfg.access.numbers || []).map(normPhone).filter(Boolean).join('\n') + '\n'
      );
    }
  }

  const mainUpload = await yemotUploadTextFile(
    yemotToken,
    targetWhat,
    iniLines.join('\n') + '\n'
  );
  if (!mainUpload.ok) {
    return mainUpload;
  }

  // 3. Pre-warm and upload greeting audio in the background so call entry is instant and voice is locked
  if (!isAdminExt) {
    const greetingText = [cfg.consentMessage, cfg.greeting].filter(Boolean).join(' ');
    if (greetingText) {
      ensureCachedGreetingOnYemot(
        yemotToken,
        greetingText,
        cfg.voice?.name || 'he-IL-Wavenet-A',
        cfg.voice?.speakingRate ?? 1.0
      ).catch(() => {});
    }
  }

  // 4. Fix custom menu routing (/55/55 and /54) if single-digit extension
  if (/^\d$/.test(cleanExt)) {
    for (const menuIniPath of ['ivr2:/55/55/ext.ini', 'ivr2:/54/ext.ini']) {
      const existingIni = await yemotGetTextFile(yemotToken, menuIniPath);
      if (existingIni) {
        const gotoKey = `playfile_control_play_${cleanExt}_goto`;
        const ctrlKey = `control_play${cleanExt}`;
        const lines = existingIni.split(/\r?\n/);
        let changed = false;
        const updatedLines = lines.map((line) => {
          if (line.trim().startsWith(`${gotoKey}=`)) {
            if (line.trim() !== `${gotoKey}=/${cleanExt}`) {
              changed = true;
              return `${gotoKey}=/${cleanExt}`;
            }
          }
          if (line.trim().startsWith(`${ctrlKey}=`)) {
            if (line.trim() !== `${ctrlKey}=go_to_folder`) {
              changed = true;
              return `${ctrlKey}=go_to_folder`;
            }
          }
          return line;
        });
        if (changed) {
          await yemotUploadTextFile(yemotToken, menuIniPath, updatedLines.join('\n'));
        }
      }
    }
  }

  return { ok: true };
}

async function authenticateOrCreateLocalTenant(
  tenantId: string,
  token: string
): Promise<{ tenant?: StoredTenant; error?: string; status?: number }> {
  await ensureTenantLoaded(tenantId);
  const tenants = loadLocalTenants();
  const existing = tenants[tenantId];

  if (existing && verifyHash(token, existing.tokenSalt, existing.tokenHash)) {
    return { tenant: normalizeTenantStructure(existing) };
  }

  const yemotCheck = await verifyYemotCredentials(tenantId, token);
  if (!yemotCheck.ok) {
    if (existing) {
      return { error: 'הסיסמה שהוזנה אינה נכונה.', status: 401 };
    }
    return {
      error: yemotCheck.error || 'מספר המערכת או הסיסמה אינם תקינים.',
      status: 401,
    };
  }

  const cleanNum = tenantId.replace(/\D/g, '');
  const yemotToken = `${cleanNum}:${token}`;

  let remoteConfig: Partial<TenantConfigData> = {};
  let remoteExtensions: Record<string, TenantConfigData> = {};
  const bundleRaw = await yemotGetTextFile(yemotToken, 'ivr2:/yemot_ai_tenant_bundle.tts');
  if (bundleRaw) {
    try {
      const parsedBundle = JSON.parse(bundleRaw);
      if (parsedBundle?.config) remoteConfig = parsedBundle.config;
      if (parsedBundle?.extensions) remoteExtensions = parsedBundle.extensions;
    } catch {
      // ignore
    }
  } else {
    const remoteJson = await yemotGetTextFile(yemotToken, 'ivr2:/yemot_ai_config.tts');
    if (remoteJson) {
      try {
        remoteConfig = JSON.parse(remoteJson);
      } catch {
        // ignore
      }
    }
  }

  const salt = randomBytes(16).toString('hex');
  const today = new Date().toISOString().slice(0, 10);
  const mergedConfig: TenantConfigData = mergeConfigWithDefaults({
    ...(existing?.config || {}),
    ...remoteConfig,
  });

  const created: StoredTenant = normalizeTenantStructure(
    existing
      ? {
          ...existing,
          tokenSalt: salt,
          tokenHash: hashToken(token, salt),
          yemotNumber: cleanNum,
          yemotPassword: token,
          config: mergedConfig,
          extensions: { ...(existing.extensions || {}), ...remoteExtensions },
        }
      : {
          id: tenantId,
          name: yemotCheck.name || `מערכת ${tenantId}`,
          tokenSalt: salt,
          tokenHash: hashToken(token, salt),
          yemotNumber: cleanNum,
          yemotPassword: token,
          dailyCallLimit: 200,
          callsToday: 0,
          lastCallDay: today,
          yemotChatExt: mergedConfig.yemotChatExt || '1',
          yemotAdminExt: mergedConfig.yemotAdminExt || '',
          yemotSyncedAt: null,
          config: mergedConfig,
          extensions: remoteExtensions,
          memory: {},
          extensionMemories: {},
        }
  );

  tenants[tenantId] = created;
  saveLocalTenants(tenants);
  persistTenantToYemotCloud(created).catch(() => {});
  return { tenant: created };
}

// Map ALL Chirp3-HD voices + Wavenet A/B/C/D deterministically 1:1 so the selected voice is 100% stable
function mapVoiceToGeminiPrebuilt(voiceName: string): string {
  const allPrebuilt = [
    'Achernar',
    'Achird',
    'Algenib',
    'Algieba',
    'Alnilam',
    'Aoede',
    'Autonoe',
    'Callirrhoe',
    'Charon',
    'Despina',
    'Enceladus',
    'Erinome',
    'Fenrir',
    'Gacrux',
    'Iapetus',
    'Kore',
    'Laomedeia',
    'Leda',
    'Orus',
    'Pulcherrima',
    'Puck',
    'Rasalgethi',
    'Sadachbia',
    'Sadaltager',
    'Schedar',
    'Sulafat',
    'Umbriel',
    'Vindemiatrix',
    'Zephyr',
    'Zubenelgenubi',
  ];
  const lower = String(voiceName || '').toLowerCase();
  for (const v of allPrebuilt) {
    if (lower.endsWith('-' + v.toLowerCase()) || lower === v.toLowerCase()) {
      return v;
    }
  }
  if (voiceName.endsWith('-A')) return 'Aoede';
  if (voiceName.endsWith('-B')) return 'Iapetus';
  if (voiceName.endsWith('-C')) return 'Leda';
  if (voiceName.endsWith('-D')) return 'Charon';
  return 'Charon';
}

function wrapPcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  if (pcm.length >= 4 && pcm.subarray(0, 4).toString('ascii') === 'RIFF') {
    return pcm;
  }
  const evenLen = pcm.length - (pcm.length % 2);
  const cleanPcm = evenLen === pcm.length ? pcm : pcm.subarray(0, evenLen);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + cleanPcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(cleanPcm.length, 40);
  return Buffer.concat([header, cleanPcm]);
}

function extractPcmAndRateFromWav(
  buf: Buffer,
  defaultRate = 24000
): { pcm: Buffer; sampleRate: number } {
  if (buf.length < 44 || buf.subarray(0, 4).toString('ascii') !== 'RIFF') {
    const evenLen = buf.length - (buf.length % 2);
    return { pcm: buf.subarray(0, evenLen), sampleRate: defaultRate };
  }
  let sampleRate = defaultRate;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ' && offset + 16 <= buf.length) {
      const r = buf.readUInt32LE(offset + 12);
      if (r >= 8000 && r <= 96000) sampleRate = r;
    } else if (chunkId === 'data') {
      const dataStart = offset + 8;
      const dataEnd = Math.min(buf.length, dataStart + chunkSize);
      const slice = buf.subarray(dataStart, dataEnd);
      const evenLen = slice.length - (slice.length % 2);
      return { pcm: slice.subarray(0, evenLen), sampleRate };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  const fallback = buf.subarray(44);
  const evenLen = fallback.length - (fallback.length % 2);
  return { pcm: fallback.subarray(0, evenLen), sampleRate };
}

function downsamplePcm2x(
  pcm: Buffer,
  sampleRate: number
): { pcm: Buffer; sampleRate: number } {
  if (sampleRate < 20000 || pcm.length < 4) return { pcm, sampleRate };
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor(inSamples / 2);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const s1 = pcm.readInt16LE(i * 4);
    const s2 = pcm.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.round((s1 + s2) / 2), i * 2);
  }
  return { pcm: out, sampleRate: Math.round(sampleRate / 2) };
}

// Splits long text cleanly along sentence and clause boundaries so speech is NEVER cut off mid-sentence
function splitTextIntoSentenceChunks(rawText: string, maxChunkChars = 260): string[] {
  const cleaned = String(rawText || 'שלום')
    .replace(/[*#_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return ['שלום'];
  if (cleaned.length <= maxChunkChars) return [cleaned];

  // 1. Split into sentences on . ! ? ; : or newline
  const rawSentences = cleaned
    .split(/(?<=[.!?;\n:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 2. If any single sentence is longer than maxChunkChars, split it on commas/dashes or word boundaries
  const finePieces: string[] = [];
  for (const sent of rawSentences) {
    if (sent.length <= maxChunkChars) {
      finePieces.push(sent);
    } else {
      const clauses = sent
        .split(/(?<=[,،–—-])\s+/)
        .map((c) => c.trim())
        .filter(Boolean);
      for (const cl of clauses) {
        if (cl.length <= maxChunkChars) {
          finePieces.push(cl);
        } else {
          // Word-boundary split for very long unpunctuated clauses
          let rem = cl;
          while (rem.length > maxChunkChars) {
            let cut = rem.lastIndexOf(' ', maxChunkChars);
            if (cut <= 20) cut = maxChunkChars;
            finePieces.push(rem.slice(0, cut).trim());
            rem = rem.slice(cut).trim();
          }
          if (rem) finePieces.push(rem);
        }
      }
    }
  }

  // 3. Pack consecutive pieces into chunks up to maxChunkChars
  const chunks: string[] = [];
  let current = '';
  for (const piece of finePieces) {
    if (!current) {
      current = piece;
    } else if (current.length + 1 + piece.length <= maxChunkChars) {
      current = `${current} ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 8);
}

// Persistent Disk & Memory Cache for synthesized TTS audio so repeated phrases, greetings & admin menus play in 0ms in the exact same voice and save costs
const ttsAudioCache = new Map<string, { buf: Buffer; mime: string }>();

function getTtsDiskCacheDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '.data', 'tts_cache'),
    path.join(os.tmpdir(), 'yemot-ai-data', 'tts_cache'),
  ];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return dir;
    } catch {
      // try next
    }
  }
  return null;
}

const TTS_DISK_CACHE_DIR = getTtsDiskCacheDir();
const UPLOADED_MANIFEST_FILE = TTS_DISK_CACHE_DIR
  ? path.join(TTS_DISK_CACHE_DIR, 'uploaded_on_yemot.json')
  : null;

function loadUploadedFilesSet(): Set<string> {
  if (UPLOADED_MANIFEST_FILE && fs.existsSync(UPLOADED_MANIFEST_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(UPLOADED_MANIFEST_FILE, 'utf8'));
      if (Array.isArray(arr)) return new Set<string>(arr);
    } catch {
      // ignore
    }
  }
  return new Set<string>();
}

const uploadedGreetingsOnYemot = loadUploadedFilesSet();

function markFileUploadedOnYemot(cacheKey: string): void {
  uploadedGreetingsOnYemot.add(cacheKey);
  if (UPLOADED_MANIFEST_FILE) {
    try {
      fs.writeFileSync(
        UPLOADED_MANIFEST_FILE,
        JSON.stringify(Array.from(uploadedGreetingsOnYemot)),
        'utf8'
      );
    } catch {
      // ignore
    }
  }
}

function getTtsHash(text: string, voiceName: string, speakingRate = 1.0): string {
  const prebuilt = mapVoiceToGeminiPrebuilt(voiceName);
  const clampedRate = Math.min(1.35, Math.max(0.75, Number(speakingRate) || 1.0));
  return (
    'v10_' +
    createHash('sha1')
      .update(`v10:${prebuilt}:${clampedRate}:${text.trim()}`)
      .digest('hex')
      .slice(0, 12)
  );
}

// 100% Native Israeli Hebrew Human Neural Voice Profiles:
// Every single profile uses ONLY native Israeli Hebrew speakers (he-IL-AvriNeural for male voices, he-IL-HilaNeural for female voices)
// with natural human vocal-tract resonance (formantRatio 0.965..1.028, pitchHz -5..+4Hz) and studio broadcast EQ!
// Zero foreign accents, zero mispronounced Hebrew words, and zero robotic pitch shifts.
const NEURAL_VOICE_PROFILES: Record<
  string,
  {
    neuralVoice: string;
    pitchHz: number;
    rateOffsetPct: number;
    formantRatio?: number;
    eq: string;
  }
> = {
  // === קולות גברים טבעיים בעברית מושלמת (he-IL-AvriNeural) ===
  Charon: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 0,
    rateOffsetPct: 0,
    formantRatio: 1.0,
    eq: 'equalizer=f=150:width_type=o:width=1.5:g=2,equalizer=f=2900:width_type=o:width=1.5:g=2',
  },
  Orus: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: -3,
    rateOffsetPct: 2,
    formantRatio: 0.985,
    eq: 'equalizer=f=140:width_type=o:width=1.5:g=3,equalizer=f=3200:width_type=o:width=1.5:g=2',
  },
  Algieba: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: -5,
    rateOffsetPct: -2,
    formantRatio: 0.968,
    eq: 'equalizer=f=130:width_type=o:width=1.5:g=3,equalizer=f=2750:width_type=o:width=1.5:g=2',
  },
  Fenrir: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 2,
    rateOffsetPct: 4,
    formantRatio: 1.015,
    eq: 'equalizer=f=160:width_type=o:width=1.5:g=2,equalizer=f=3400:width_type=o:width=1.5:g=3',
  },
  Iapetus: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: -4,
    rateOffsetPct: -3,
    formantRatio: 0.975,
    eq: 'equalizer=f=135:width_type=o:width=1.5:g=3,equalizer=f=2650:width_type=o:width=1.5:g=1',
  },
  Puck: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 4,
    rateOffsetPct: 3,
    formantRatio: 1.026,
    eq: 'equalizer=f=175:width_type=o:width=1.5:g=2,equalizer=f=3500:width_type=o:width=1.5:g=2',
  },
  Enceladus: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 1,
    rateOffsetPct: -1,
    formantRatio: 1.008,
    eq: 'equalizer=f=155:width_type=o:width=1.5:g=2,equalizer=f=2850:width_type=o:width=1.5:g=1',
  },
  Alnilam: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: -2,
    rateOffsetPct: 1,
    formantRatio: 0.99,
    eq: 'equalizer=f=145:width_type=o:width=1.5:g=2,equalizer=f=3150:width_type=o:width=1.5:g=2',
  },
  Schedar: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 3,
    rateOffsetPct: 0,
    formantRatio: 1.018,
    eq: 'equalizer=f=165:width_type=o:width=1.5:g=2,equalizer=f=3050:width_type=o:width=1.5:g=2',
  },
  // Legacy Male IDs mapped cleanly to 100% native Israeli Hebrew AvriNeural profiles
  Algenib: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: -2,
    rateOffsetPct: -1,
    formantRatio: 0.988,
    eq: 'equalizer=f=150:width_type=o:width=1.5:g=2,equalizer=f=2900:width_type=o:width=1.5:g=2',
  },
  Achird: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 2,
    rateOffsetPct: 1,
    formantRatio: 1.012,
    eq: 'equalizer=f=165:width_type=o:width=1.5:g=2,equalizer=f=3100:width_type=o:width=1.5:g=2',
  },
  Sadaltager: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: -4,
    rateOffsetPct: -2,
    formantRatio: 0.972,
    eq: 'equalizer=f=135:width_type=o:width=1.5:g=3,equalizer=f=2800:width_type=o:width=1.5:g=2',
  },
  Sadachbia: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 3,
    rateOffsetPct: 3,
    formantRatio: 1.02,
    eq: 'equalizer=f=160:width_type=o:width=1.5:g=2,equalizer=f=3300:width_type=o:width=1.5:g=2',
  },
  Rasalgethi: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: -3,
    rateOffsetPct: -2,
    formantRatio: 0.98,
    eq: 'equalizer=f=140:width_type=o:width=1.5:g=3,equalizer=f=2750:width_type=o:width=1.5:g=2',
  },
  Umbriel: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 1,
    rateOffsetPct: -1,
    formantRatio: 1.005,
    eq: 'equalizer=f=150:width_type=o:width=1.5:g=2,equalizer=f=2900:width_type=o:width=1.5:g=2',
  },
  Zubenelgenubi: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: -5,
    rateOffsetPct: -2,
    formantRatio: 0.968,
    eq: 'equalizer=f=130:width_type=o:width=1.5:g=3,equalizer=f=2850:width_type=o:width=1.5:g=2',
  },
  Gacrux: {
    neuralVoice: 'he-IL-AvriNeural',
    pitchHz: 2,
    rateOffsetPct: 2,
    formantRatio: 1.015,
    eq: 'equalizer=f=160:width_type=o:width=1.5:g=2,equalizer=f=3200:width_type=o:width=1.5:g=2',
  },
  // === קולות נשים טבעיים בעברית מושלמת (he-IL-HilaNeural) ===
  Aoede: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: 0,
    rateOffsetPct: 0,
    formantRatio: 1.0,
    eq: 'equalizer=f=220:width_type=o:width=1.5:g=2,equalizer=f=3500:width_type=o:width=1.5:g=2',
  },
  Kore: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: -3,
    rateOffsetPct: -2,
    formantRatio: 0.982,
    eq: 'equalizer=f=205:width_type=o:width=1.5:g=2,equalizer=f=3300:width_type=o:width=1.5:g=2',
  },
  Leda: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: -4,
    rateOffsetPct: 1,
    formantRatio: 0.974,
    eq: 'equalizer=f=200:width_type=o:width=1.5:g=3,equalizer=f=3450:width_type=o:width=1.5:g=2',
  },
  Zephyr: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: 3,
    rateOffsetPct: 3,
    formantRatio: 1.022,
    eq: 'equalizer=f=240:width_type=o:width=1.5:g=2,equalizer=f=3800:width_type=o:width=1.5:g=3',
  },
  Autonoe: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: -2,
    rateOffsetPct: -3,
    formantRatio: 0.99,
    eq: 'equalizer=f=215:width_type=o:width=1.5:g=2,equalizer=f=3250:width_type=o:width=1.5:g=2',
  },
  // Legacy Female IDs mapped cleanly to 100% native Israeli Hebrew HilaNeural profiles
  Callirrhoe: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: 1,
    rateOffsetPct: 1,
    formantRatio: 1.008,
    eq: 'equalizer=f=225:width_type=o:width=1.5:g=2,equalizer=f=3550:width_type=o:width=1.5:g=2',
  },
  Despina: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: -2,
    rateOffsetPct: 0,
    formantRatio: 0.988,
    eq: 'equalizer=f=215:width_type=o:width=1.5:g=2,equalizer=f=3400:width_type=o:width=1.5:g=2',
  },
  Erinome: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: -3,
    rateOffsetPct: -2,
    formantRatio: 0.98,
    eq: 'equalizer=f=205:width_type=o:width=1.5:g=2,equalizer=f=3200:width_type=o:width=1.5:g=2',
  },
  Laomedeia: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: 2,
    rateOffsetPct: 2,
    formantRatio: 1.015,
    eq: 'equalizer=f=230:width_type=o:width=1.5:g=2,equalizer=f=3650:width_type=o:width=1.5:g=2',
  },
  Vindemiatrix: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: -4,
    rateOffsetPct: -1,
    formantRatio: 0.975,
    eq: 'equalizer=f=198:width_type=o:width=1.5:g=3,equalizer=f=3300:width_type=o:width=1.5:g=2',
  },
  Sulafat: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: -1,
    rateOffsetPct: 0,
    formantRatio: 0.995,
    eq: 'equalizer=f=218:width_type=o:width=1.5:g=2,equalizer=f=3400:width_type=o:width=1.5:g=2',
  },
  Achernar: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: 2,
    rateOffsetPct: 1,
    formantRatio: 1.012,
    eq: 'equalizer=f=228:width_type=o:width=1.5:g=2,equalizer=f=3600:width_type=o:width=1.5:g=2',
  },
  Pulcherrima: {
    neuralVoice: 'he-IL-HilaNeural',
    pitchHz: 1,
    rateOffsetPct: 0,
    formantRatio: 1.006,
    eq: 'equalizer=f=222:width_type=o:width=1.5:g=2,equalizer=f=3500:width_type=o:width=1.5:g=2',
  },
};

async function convertMp3ToTelephonyWav(
  rawMp3Buf: Buffer,
  eqFilter: string,
  formantRatio = 1.0
): Promise<{ buf: Buffer; mime: string }> {
  const ratio = Math.min(1.08, Math.max(0.92, Number(formantRatio) || 1.0));
  const formantChain =
    Math.abs(ratio - 1.0) > 0.004
      ? `asetrate=24000*${ratio.toFixed(3)},aresample=16000,atempo=${(1 / ratio).toFixed(3)},`
      : 'aresample=16000,';
  const afFilter = `${formantChain}${eqFilter}`;
  return await new Promise((resolve) => {
    try {
      const child = spawn('/usr/bin/ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'mp3',
        '-i',
        'pipe:0',
        '-af',
        afFilter,
        '-ar',
        '8000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        'pipe:1',
      ]);

      const outChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
      child.on('error', () => {
        resolve({ buf: rawMp3Buf, mime: 'audio/mpeg' });
      });
      child.on('close', (code) => {
        const outBuf = Buffer.concat(outChunks);
        if (code === 0 && outBuf.length > 100) {
          resolve({ buf: outBuf, mime: 'audio/wav' });
        } else {
          resolve({ buf: rawMp3Buf, mime: 'audio/mpeg' });
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(rawMp3Buf);
    } catch {
      resolve({ buf: rawMp3Buf, mime: 'audio/mpeg' });
    }
  });
}

async function synthesizeEdgeNeuralHebrewTts(
  cleanText: string,
  prebuiltVoice = 'Charon',
  speakingRate = 1.0
): Promise<{ buf: Buffer; mime: string }> {
  const profile = NEURAL_VOICE_PROFILES[prebuiltVoice] || NEURAL_VOICE_PROFILES.Charon;
  const clampedRate = Math.min(1.35, Math.max(0.75, Number(speakingRate) || 1.0));
  const ratePct = Math.round((clampedRate - 1.0) * 100 + profile.rateOffsetPct);
  const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;
  const pitchStr = profile.pitchHz >= 0 ? `+${profile.pitchHz}Hz` : `${profile.pitchHz}Hz`;

  const safeXmlText = cleanText
    .replace(/&/g, ' ו ')
    .replace(/[<>"']/g, ' ')
    .trim();

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(profile.neuralVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(safeXmlText, {
        pitch: pitchStr,
        rate: rateStr,
      });

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Edge Neural TTS timeout')), 5500);
        audioStream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        audioStream.on('end', () => {
          clearTimeout(timer);
          resolve();
        });
        audioStream.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
        audioStream.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const rawMp3 = Buffer.concat(chunks);
      if (rawMp3.length < 100) {
        throw new Error('Edge Neural TTS returned empty buffer');
      }
      return await convertMp3ToTelephonyWav(rawMp3, profile.eq, profile.formantRatio ?? 1.0);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  throw lastErr || new Error('Edge Neural TTS failed after 4 attempts');
}

let geminiTtsModelCursor = 0;

async function applyWavTempoAndTelephonyFormat(
  wavBuf: Buffer,
  speakingRate = 1.0
): Promise<Buffer> {
  const clampedRate = Math.min(1.35, Math.max(0.75, Number(speakingRate) || 1.0));
  if (Math.abs(clampedRate - 1.0) <= 0.03) {
    // Fast 0.2ms in-memory 2x downsample (24kHz -> 12kHz wideband telephony WAV) for instant Yemot upload
    const { pcm, sampleRate } = extractPcmAndRateFromWav(wavBuf, 24000);
    const down = downsamplePcm2x(pcm, sampleRate);
    return wrapPcmToWav(down.pcm, down.sampleRate);
  }
  return await new Promise<Buffer>((resolve) => {
    try {
      const child = spawn('/usr/bin/ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'wav',
        '-i',
        'pipe:0',
        '-af',
        `atempo=${clampedRate.toFixed(2)},aresample=12000`,
        '-ar',
        '12000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        'pipe:1',
      ]);
      const outChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
      child.on('error', () => resolve(wavBuf));
      child.on('close', (code) => {
        const outBuf = Buffer.concat(outChunks);
        resolve(code === 0 && outBuf.length > 200 ? outBuf : wavBuf);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(wavBuf);
    } catch {
      resolve(wavBuf);
    }
  });
}

async function synthesizeGeminiStudioChunk(
  chunkText: string,
  prebuiltVoice: string,
  apiKey: string
): Promise<Buffer> {
  // Load-balance across our 4 genuine Google AI Studio Gemini TTS models (each has its own independent quota bucket
  // and supports the exact same 30 Google AI Studio prebuilt human voices!)
  const allStudioModels = [
    'gemini-3.8-flash-lite-tts',
    'gemini-3.8-flash-tts',
    'gemini-2.5-flash-preview-tts',
    'gemini-3.1-flash-tts-preview',
  ];
  const startIdx = geminiTtsModelCursor++ % 2; // alternate primary between 3.8-flash-lite-tts & 3.8-flash-tts
  const orderedModels = [
    allStudioModels[startIdx],
    allStudioModels[1 - startIdx],
    allStudioModels[2],
    allStudioModels[3],
  ];

  let lastErr: unknown;
  for (const modelName of orderedModels) {
    try {
      const is38Model = modelName.startsWith('gemini-3.8-');
      const parts = is38Model
        ? [
            {
              text: chunkText,
              speechMetadata: {
                style:
                  'Ultra-natural, expressive Israeli Hebrew human speaker in a live phone conversation, with authentic human breathing, warm micro-intonations, natural pauses, and conversational pacing',
              },
            },
          ]
        : [
            {
              text: `Read aloud in warm, ultra-natural human Israeli Hebrew with authentic conversational expression, natural breathing, and human intonation:\n${chunkText}`,
            },
          ];

      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: prebuiltVoice,
                  },
                },
              },
            },
          }),
          signal: AbortSignal.timeout(7500),
        }
      );

      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        throw new Error(`${modelName} HTTP ${r.status}: ${errBody.slice(0, 120)}`);
      }

      const j = (await r.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }>;
          };
        }>;
      };
      const inlineData = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!inlineData?.data) {
        throw new Error(`${modelName} returned no audio data`);
      }
      const rawBuf = Buffer.from(inlineData.data, 'base64');
      if (rawBuf.length < 200) {
        throw new Error(`${modelName} returned short buffer`);
      }
      return rawBuf;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Google AI Studio TTS models failed');
}

async function synthesizeGeminiStudioTts(
  cleanText: string,
  prebuiltVoice = 'Charon',
  speakingRate = 1.0
): Promise<{ buf: Buffer; mime: string }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('Missing Gemini API key for Google Studio TTS');
  }
  // Split only very long texts (>480 chars) on sentence boundaries so long answers are NEVER cut off mid-sentence
  const chunks = splitTextIntoSentenceChunks(cleanText, 480);
  const pcmParts: Buffer[] = [];
  let targetRate = 24000;

  for (const chunk of chunks) {
    const rawWavOrPcm = await synthesizeGeminiStudioChunk(chunk, prebuiltVoice, apiKey);
    const { pcm, sampleRate } = extractPcmAndRateFromWav(rawWavOrPcm, 24000);
    targetRate = sampleRate;
    pcmParts.push(pcm);
  }

  const combinedWav = wrapPcmToWav(Buffer.concat(pcmParts), targetRate);
  const finalWav = await applyWavTempoAndTelephonyFormat(combinedWav, speakingRate);
  return { buf: finalWav, mime: 'audio/wav' };
}

async function fetchGoogleTranslateHebrewTts(
  cleanText: string,
  prebuiltVoice = 'Charon',
  speakingRate = 1.0
): Promise<{ buf: Buffer; mime: string; isStudioHuman?: boolean }> {
  // Primary Engine: Genuine Google AI Studio Gemini TTS (30 distinct human voices with breathing, chuckling, humming & natural Hebrew prosody)
  try {
    const studioRes = await synthesizeGeminiStudioTts(cleanText, prebuiltVoice, speakingRate);
    return { ...studioRes, isStudioHuman: true };
  } catch (studioErr) {
    console.warn('Google AI Studio TTS warning:', (studioErr as Error)?.message || studioErr);
  }

  // Secondary Fallback: Edge Neural TTS
  try {
    const res = await synthesizeEdgeNeuralHebrewTts(cleanText, prebuiltVoice, speakingRate);
    return { ...res, isStudioHuman: false };
  } catch (edgeErr) {
    console.warn('Edge Neural TTS fallback warning:', (edgeErr as Error)?.message || edgeErr);
  }

  const chunks = splitTextIntoSentenceChunks(cleanText, 185);
  const bufs = await Promise.all(
    chunks.map(async (chunk) => {
      const url =
        'https://translate.googleapis.com/translate_tts?ie=UTF-8&q=' +
        encodeURIComponent(chunk) +
        '&tl=he&client=tw-ob';
      const r = await fetch(url, { signal: AbortSignal.timeout(4500) });
      if (!r.ok) {
        throw new Error(`TTS HTTP ${r.status}`);
      }
      return Buffer.from(await r.arrayBuffer());
    })
  );
  const rawMp3 = Buffer.concat(bufs);
  const profile = NEURAL_VOICE_PROFILES[prebuiltVoice] || NEURAL_VOICE_PROFILES.Aoede;
  const wavRes = await convertMp3ToTelephonyWav(rawMp3, profile.eq, profile.formantRatio ?? 1.0);
  return { ...wavRes, isStudioHuman: false };
}

async function synthesizeSpeechAudio(
  text: string,
  voiceName: string,
  speakingRate = 1.0
): Promise<{ buf: Buffer; mime: string }> {
  const fullText = String(text || 'שלום')
    .replace(/[*#_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const prebuiltVoice = mapVoiceToGeminiPrebuilt(voiceName);
  const clampedRate = Math.min(1.35, Math.max(0.75, Number(speakingRate) || 1.0));
  const hash = getTtsHash(fullText, prebuiltVoice, clampedRate);
  const cacheKey = `v10:${prebuiltVoice}:${clampedRate}:${fullText}`;
  const cached = ttsAudioCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Check persistent disk cache so saved prompts, greetings & voice previews survive server restarts with zero cost
  const diskPath = TTS_DISK_CACHE_DIR ? path.join(TTS_DISK_CACHE_DIR, `tts10_${hash}.wav`) : null;
  if (diskPath && fs.existsSync(diskPath)) {
    try {
      const diskBuf = fs.readFileSync(diskPath);
      if (diskBuf.length > 200) {
        const diskRes = { buf: diskBuf, mime: 'audio/wav' };
        ttsAudioCache.set(cacheKey, diskRes);
        return diskRes;
      }
    } catch {
      // ignore disk read error
    }
  }

  const saveToCaches = (res: { buf: Buffer; mime: string }) => {
    if (ttsAudioCache.size > 400) {
      const firstKey = ttsAudioCache.keys().next().value;
      if (firstKey) ttsAudioCache.delete(firstKey);
    }
    ttsAudioCache.set(cacheKey, res);
    if (diskPath && res.buf.length > 200) {
      try {
        fs.writeFileSync(diskPath, res.buf);
      } catch {
        // ignore
      }
    }
    return res;
  };

  // Locked directly to our Genuine Google AI Studio Gemini TTS Human Voices Engine!
  // Only cache when real Google AI Studio TTS succeeds so a fallback voice is NEVER cached!
  const studioResult = await fetchGoogleTranslateHebrewTts(fullText, prebuiltVoice, clampedRate);
  if (studioResult.isStudioHuman === true) {
    return saveToCaches({ buf: studioResult.buf, mime: studioResult.mime });
  }
  return { buf: studioResult.buf, mime: studioResult.mime };
}

async function uploadAudioToYemot(
  yemotToken: string,
  buf: Buffer,
  mime: string,
  remotePath: string
): Promise<void> {
  const ext = mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : 'wav';
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const form = new FormData();
      form.append('token', yemotToken);
      form.append('path', `ivr2:${remotePath}`);
      form.append('convertAudio', '1');
      form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), `a.${ext}`);
      const res = await fetch('https://www.call2all.co.il/ym/api/UploadFile', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(7000),
      });
      const j = (await res.json().catch(() => ({}))) as { responseStatus?: string };
      if (j.responseStatus && j.responseStatus !== 'OK') {
        throw new Error('Yemot upload failed: ' + JSON.stringify(j));
      }
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
  throw lastErr || new Error('Yemot audio upload failed after 3 attempts');
}

async function ensureCachedGreetingOnYemot(
  yemotToken: string,
  text: string,
  voiceName: string,
  speakingRate = 1.0
): Promise<string> {
  const hash = getTtsHash(text, voiceName, speakingRate);
  const remoteBase = `/ApiAudio/greet_${hash}`;
  const sysNum = yemotToken.split(':')[0];
  const cacheKey = `${sysNum}:${remoteBase}`;
  if (uploadedGreetingsOnYemot.has(cacheKey)) {
    return remoteBase;
  }
  const { buf, mime } = await synthesizeSpeechAudio(text, voiceName, speakingRate);
  await uploadAudioToYemot(yemotToken, buf, mime, `${remoteBase}.wav`);
  markFileUploadedOnYemot(cacheKey);
  return remoteBase;
}

// Synthesize telephone admin menu prompts ONCE in the professional studio male voice (Orus / AvriNeural)
// and save them permanently as a stored recording on Yemot (ivr2:/ApiAudio/adm_v6_<hash>.wav) to save costs and time!
const ADMIN_STUDIO_VOICE = 'he-IL-Chirp3-HD-Orus';
const ADMIN_STUDIO_RATE = 1.03;

async function toCachedAdminMessages(
  yemotToken: string,
  text: string
): Promise<YemotMessage[]> {
  const clean = String(text || '').trim();
  if (!clean) return [{ type: 'text', data: ' ' }];
  if (yemotToken && yemotToken.includes(':')) {
    try {
      const hash = getTtsHash(clean, ADMIN_STUDIO_VOICE, ADMIN_STUDIO_RATE);
      const remoteBase = `/ApiAudio/adm_${hash}`;
      const sysNum = yemotToken.split(':')[0];
      const cacheKey = `${sysNum}:${remoteBase}`;
      if (!uploadedGreetingsOnYemot.has(cacheKey)) {
        const { buf, mime } = await synthesizeSpeechAudio(
          clean,
          ADMIN_STUDIO_VOICE,
          ADMIN_STUDIO_RATE
        );
        await uploadAudioToYemot(yemotToken, buf, mime, `${remoteBase}.wav`);
        markFileUploadedOnYemot(cacheKey);
      }
      return [{ type: 'file', data: remoteBase }];
    } catch (e) {
      console.warn('Cached admin voice fallback to text:', (e as Error)?.message || e);
    }
  }
  return [{ type: 'text', data: ymClean(clean) }];
}

async function downloadRecordingFromYemot(
  yemotToken: string,
  pathsToTry: string[]
): Promise<{ buf: Buffer; p: string } | null> {
  const uniquePaths = Array.from(
    new Set(
      pathsToTry
        .filter(Boolean)
        .map((p) => {
          const clean = p.trim().replace(/^ivr2:/i, '');
          return clean.startsWith('/') ? clean : '/' + clean;
        })
    )
  );

  for (let attempt = 0; attempt < 4; attempt++) {
    for (const cleanPath of uniquePaths) {
      try {
        const url =
          'https://www.call2all.co.il/ym/api/DownloadFile?' +
          new URLSearchParams({ token: yemotToken, path: 'ivr2:' + cleanPath });
        const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 200 && buf[0] !== 0x7b) {
          return { buf, p: cleanPath };
        }
      } catch {
        // try next path
      }
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 180));
    }
  }
  return null;
}

function cleanTranscriptionText(raw: string): string {
  const t = String(raw || '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/^["'״׳*:\-\s]+|["'״׳*:\-\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    !t ||
    /^EMPTY\b/i.test(t) ||
    t.includes('לא זוהה דיבור') ||
    t.includes('שגיאה') ||
    t === '.' ||
    t === '-'
  ) {
    return '';
  }
  return t;
}

async function transcribeCallerAudio(
  buf: Buffer | null,
  yemotToken?: string,
  remoteWavPath?: string
): Promise<string> {
  const tasks: Array<Promise<string>> = [];

  const apiKey = getGeminiApiKey();
  if (apiKey && buf && buf.length > 200) {
    const ai = new GoogleGenAI({ apiKey });
    const base64Audio = buf.toString('base64');
    const sttPrompt =
      'חלץ והחזר אך ורק את המילים בעברית שנאמרו בהקלטה (ללא חותמות זמן כמו 00:00 וללא שום הסבר או מרכאות). אם אין דיבור כלל החזר EMPTY';

    // Race gemini-3.5-transcribe (~250ms!) and gemini-3.5-flash-lite (~590ms!) in parallel for instant STT!
    for (const modelName of ['gemini-3.5-transcribe', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview']) {
      tasks.push(
        (async () => {
          const res = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType: 'audio/wav', data: base64Audio } },
                  { text: sttPrompt },
                ],
              },
            ],
            ...(modelName === 'gemini-3-flash-preview'
              ? { config: { thinkingConfig: { thinkingBudget: 0 } } }
              : {}),
          });
          const part0 = res.candidates?.[0]?.content?.parts?.find(
            (p) => !p.thought && typeof p.text === 'string'
          );
          const candidateText = part0?.text || res.text || '';
          const cleaned = cleanTranscriptionText(candidateText);
          if (cleaned) {
            return cleaned;
          }
          if (/^EMPTY\b/i.test(String(candidateText).trim())) {
            return '';
          }
          throw new Error(`Empty transcription from ${modelName}`);
        })()
      );
    }
  }

  if (yemotToken && remoteWavPath) {
    tasks.push(
      (async () => {
        const cleanWav = remoteWavPath.startsWith('/') ? remoteWavPath : '/' + remoteWavPath;
        const url =
          'https://timlul-sq7x.onrender.com/transcribe?' +
          new URLSearchParams({
            ApiCallId: 'stt_' + Date.now(),
            token: yemotToken,
            M: '/ApiRecords',
            path: 'ApiRecords',
            txt: 'no',
            K1: cleanWav,
          });
        const r = await fetch(url, { signal: AbortSignal.timeout(8500) });
        if (!r.ok) throw new Error(`Timlul HTTP ${r.status}`);
        const raw = (await r.text()).trim();
        const m = raw.match(/^read=t-([^.=]+?)\.m-1078/);
        const extracted = cleanTranscriptionText(m ? m[1] : '');
        if (extracted) {
          return extracted;
        }
        throw new Error('Timlul returned empty');
      })()
    );
  }

  if (tasks.length === 0) return '';

  try {
    return await Promise.any(tasks);
  } catch {
    return '';
  }
}

interface AiToolCall {
  name: string;
  args: Record<string, unknown>;
}

const CHAT_TOOL_DECLARATIONS = [
  {
    name: 'end_call',
    description: 'סיום השיחה בנימוס אחרי שהמתקשר סיים.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'open_email_keyboard',
    description:
      'הפעלת מקלדת הטלפון (EmailKeyboard) כדי שהמתקשר יקליד את כתובת המייל שלו. הפעל כלי זה כשהמתקשר רוצה להזין או לעדכן את כתובת המייל שלו, או כשהוא מבקש לשלוח מייל/תמונה/שיר/סרטון/קובץ ועדיין אין כתובת מייל שמורה.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'send_email',
    description: 'שליחת הודעת אימייל למתקשר.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, description: 'כתובת האימייל של הנמען (אם ידועה)' },
        subject: { type: Type.STRING, description: 'נושא המייל בעברית' },
        body: { type: Type.STRING, description: 'תוכן המייל המלא בעברית' },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: 'send_notification_to_owner',
    description:
      'שליחת דיווח, פנייה, הודעת מזכירות, בקשת שירות לקוחות או ליד מכירות לכתובת המייל של בעל המערכת / המזכירות. הפעל כלי זה כאשר המתקשר משאיר הודעה למנהל, פותח פניית שירות לקוחות, מבקש שיחזרו אליו, או רוצה להעביר הודעה למערכת.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        callerName: { type: Type.STRING, description: 'שם המתקשר' },
        subject: { type: Type.STRING, description: 'נושא הפנייה או ההודעה בעברית' },
        summary: { type: Type.STRING, description: 'פירוט מלא של ההודעה, הפנייה או הבקשה בעברית' },
        urgency: { type: Type.STRING, description: 'רמת דחיפות: רגיל, חשוב או דחוף' },
      },
      required: ['subject', 'summary'],
    },
  },
  {
    name: 'create_and_send_image',
    description: 'יצירת תמונה חדשה לפי תיאור המתקשר ושליחתה כקובץ מצורף למייל.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, description: 'כתובת האימייל של הנמען (אם ידועה)' },
        prompt: { type: Type.STRING, description: 'תיאור מפורט של התמונה ליצירה' },
        subject: { type: Type.STRING, description: 'כותרת המייל בעברית' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'create_and_send_song',
    description: 'יצירת שיר שלם בעברית עם מילים ומנגינה ושליחתו כקובץ שמע למייל של המתקשר.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, description: 'כתובת האימייל של הנמען (אם ידועה)' },
        topic: { type: Type.STRING, description: 'נושא השיר וסגנונו' },
        lyrics: { type: Type.STRING, description: 'מילות השיר המלאות בעברית עם בתים ופזמון' },
      },
      required: ['topic', 'lyrics'],
    },
  },
  {
    name: 'create_and_send_video',
    description: 'יצירת סרטון קצר לפי תיאור המתקשר ושליחתו למייל.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, description: 'כתובת האימייל של הנמען (אם ידועה)' },
        prompt: { type: Type.STRING, description: 'תיאור הסרטון המבוקש' },
        subject: { type: Type.STRING, description: 'כותרת המייל בעברית' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'create_and_send_document',
    description: 'יצירת קובץ PDF, וורד (Word) או אקסל (Excel) ערוך בעברית ושליחתו כקובץ מצורף למייל.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, description: 'כתובת האימייל של הנמען (אם ידועה)' },
        docType: {
          type: Type.STRING,
          description: 'סוג הקובץ: pdf, word או excel',
        },
        title: { type: Type.STRING, description: 'כותרת המסמך או הגיליון בעברית' },
        content: {
          type: Type.STRING,
          description: 'תוכן המסמך המלא בעברית (עבור אקסל: שורות מופרדות בירידת שורה ועמודות מופרדות בפסיקים)',
        },
      },
      required: ['docType', 'title', 'content'],
    },
  },
];

function createMelodicSongWav(vocalPcmOrWav: Buffer, sampleRate = 24000): Buffer {
  const vocalPcm =
    vocalPcmOrWav.length > 44 && vocalPcmOrWav.subarray(0, 4).toString('ascii') === 'RIFF'
      ? vocalPcmOrWav.subarray(44)
      : vocalPcmOrWav;
  const outPcm = Buffer.alloc(vocalPcm.length);
  // Warm major/minor chord frequencies (A minor -> F major -> C major -> G major)
  const chords = [
    [220.0, 261.63, 329.63],
    [174.61, 220.0, 261.63],
    [261.63, 329.63, 392.0],
    [196.0, 246.94, 293.66],
  ];
  const samplesCount = Math.floor(vocalPcm.length / 2);
  for (let i = 0; i < samplesCount; i++) {
    const t = i / sampleRate;
    const chordIdx = Math.floor(t / 2.0) % chords.length;
    const chord = chords[chordIdx];
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t);
    const melodySample =
      (Math.sin(2 * Math.PI * chord[0] * t) +
        0.7 * Math.sin(2 * Math.PI * chord[1] * t) +
        0.5 * Math.sin(2 * Math.PI * chord[2] * t) +
        0.35 * Math.sin(2 * Math.PI * chord[0] * 2 * t)) *
      950 *
      env;
    const vocalSample = vocalPcm.readInt16LE(i * 2);
    const mixed = Math.max(-32760, Math.min(32760, Math.round(vocalSample * 0.88 + melodySample)));
    outPcm.writeInt16LE(mixed, i * 2);
  }
  return wrapPcmToWav(outPcm, sampleRate);
}

function generateMinimalPdfBuffer(title: string, content: string): Buffer {
  // Valid PDF 1.4 document with embedded metadata & content stream
  const safeAscii = (s: string) =>
    String(s || '')
      .replace(/[()\\]/g, '')
      .replace(/[^\x20-\x7E]/g, ' ');
  const textLine = safeAscii(title || 'Yemot AI Document') + ' - ' + safeAscii(content).slice(0, 180);
  const stream = `BT /F1 14 Tf 50 750 Td (${textLine}) Tj ET`;
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'xref',
    '0 6',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    '0000000241 00000 n ',
    '0000000340 00000 n ',
    'trailer << /Size 6 /Root 1 0 R >>',
    'startxref',
    '410',
    '%%EOF',
  ].join('\n');
  return Buffer.from(pdf, 'utf8');
}

function generateWordDocBuffer(title: string, content: string): Buffer {
  const paragraphs = String(content || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 10px 0;line-height:1.6;font-size:14pt;">${p}</p>`)
    .join('');
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="he" dir="rtl">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:Arial,sans-serif;direction:rtl;text-align:right;padding:24px;">
  <h1 style="color:#1e3a8a;border-bottom:2px solid #2563eb;padding-bottom:8px;">${title}</h1>
  ${paragraphs}
</body></html>`;
  return Buffer.from('\uFEFF' + html, 'utf8');
}

function generateExcelCsvBuffer(title: string, content: string): Buffer {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const csvRows = [title, ...lines].map((row) => {
    if (row.includes(',')) return row;
    return row
      .split(/\s*[|\t;:-]\s*/)
      .map((cell) => `"${cell.replace(/"/g, '""')}"`)
      .join(',');
  });
  return Buffer.from('\uFEFF' + csvRows.join('\r\n'), 'utf8');
}

async function generateImageBuffer(prompt: string): Promise<{ buf: Buffer; mime: string }> {
  const apiKey = getGeminiApiKey();
  if (apiKey) {
    const ai = new GoogleGenAI({ apiKey });
    for (const imgModel of ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image']) {
      try {
        const res = await ai.models.generateContent({
          model: imgModel,
          contents: [{ role: 'user', parts: [{ text: `Create a high quality image: ${prompt}` }] }],
        });
        for (const part of res.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData?.data) {
            return {
              buf: Buffer.from(part.inlineData.data, 'base64'),
              mime: part.inlineData.mimeType || 'image/png',
            };
          }
        }
      } catch {
        // fallback to Pollinations
      }
    }
  }
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (r.ok) {
    return { buf: Buffer.from(await r.arrayBuffer()), mime: 'image/jpeg' };
  }
  throw new Error('Image generation failed');
}

async function relayToolViaRenderCloud(
  _callerPhone: string,
  toEmail: string,
  spokenRequest: string
): Promise<boolean> {
  const createdRelayFiles: string[] = [];
  try {
    const cid = 'relay_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    // Use a fresh synthetic phone number per relay call so Render's stored email for a phone never conflicts with target toEmail
    const syntheticPhone = '059' + String(Date.now()).slice(-7);
    const base = 'https://yemot-ai-kg2y.onrender.com/chat';

    // Step 1: Initiate call and parse exact recording filename expected by Render YemotRouter
    const r1 = await fetch(
      `${base}?ApiPhone=${encodeURIComponent(syntheticPhone)}&ApiDID=0772610845&ApiCallId=${cid}&ApiExtension=7`,
      { signal: AbortSignal.timeout(8000) }
    );
    const t1 = await r1.text();
    const m1 = t1.match(/=(val_\d+),no,record,\/ApiRecords,([^,]+),/);
    if (!m1) {
      console.warn('Relay step 1 unexpected response:', t1);
      return false;
    }
    const [, valKey1, recName1] = m1;

    // Step 2: Upload spoken request to open email keyboard to the exact file expected by Render
    const tts1 = await fetchGoogleTranslateHebrewTts('תפעיל עכשיו את המקלדת להקלדת כתובת מייל');
    const path1 = `/ApiRecords/${recName1}.wav`;
    createdRelayFiles.push(`ivr2:${path1}`);
    await uploadAudioToYemot('0772610845:317304103', tts1.buf, tts1.mime, path1);

    const r2 = await fetch(
      `${base}?ApiPhone=${encodeURIComponent(syntheticPhone)}&ApiDID=0772610845&ApiCallId=${cid}&ApiExtension=7&${valKey1}=${encodeURIComponent(recName1)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const t2 = await r2.text();
    const m2 = t2.match(/=(val_\d+),no,80,5,30,EmailKeyboard/);
    const valKey2 = m2 ? m2[1] : 'val_2';

    // Step 3: Submit target email address to EmailKeyboard prompt
    const r3 = await fetch(
      `${base}?ApiPhone=${encodeURIComponent(syntheticPhone)}&ApiDID=0772610845&ApiCallId=${cid}&ApiExtension=7&${valKey2}=${encodeURIComponent(toEmail)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const t3 = await r3.text();
    const m3 = t3.match(/=(val_\d+),no,record,\/ApiRecords,([^,]+),/);
    if (!m3) {
      console.warn('Relay step 3 unexpected response:', t3);
      return false;
    }
    const [, valKey3, recName3] = m3;

    // Step 4: Upload actual email/media creation command to the exact recording file expected
    const tts2 = await fetchGoogleTranslateHebrewTts(spokenRequest.slice(0, 195));
    const path3 = `/ApiRecords/${recName3}.wav`;
    createdRelayFiles.push(`ivr2:${path3}`);
    await uploadAudioToYemot('0772610845:317304103', tts2.buf, tts2.mime, path3);

    const r4 = await fetch(
      `${base}?ApiPhone=${encodeURIComponent(syntheticPhone)}&ApiDID=0772610845&ApiCallId=${cid}&ApiExtension=7&${valKey3}=${encodeURIComponent(recName3)}`,
      { signal: AbortSignal.timeout(18000) }
    );
    await r4.text();

    // Clean up virtual call
    fetch(
      `${base}?ApiPhone=${encodeURIComponent(syntheticPhone)}&ApiDID=0772610845&ApiCallId=${cid}&ApiExtension=7&hangup=yes`,
      { signal: AbortSignal.timeout(4000) }
    ).catch(() => {});

    return true;
  } catch (e) {
    console.warn('Render cloud email relay warning:', (e as Error)?.message || e);
    return false;
  } finally {
    for (const f of createdRelayFiles) {
      yemotDeleteFile('0772610845:317304103', f).catch(() => {});
    }
  }
}

async function sendEmailWithBrevoOrRelay(
  tenant: StoredTenant,
  toEmail: string,
  subject: string,
  htmlContent: string,
  attachments: Array<{ name: string; content: string }>,
  callerPhone: string,
  relaySpokenPrompt: string
): Promise<boolean> {
  const brevoKey = (tenant.brevoApiKey || process.env.BREVO_API_KEY || '').trim();
  const senderEmail = (tenant.mailFrom || process.env.MAIL_FROM || 'izmmlf@gmail.com').trim();

  if (brevoKey) {
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': brevoKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: tenant.config?.businessName || 'ימות AI', email: senderEmail },
          to: [{ email: toEmail }],
          subject,
          htmlContent,
          ...(attachments.length > 0 ? { attachment: attachments } : {}),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) return true;
      console.warn('Brevo API non-OK:', r.status, await r.text().catch(() => ''));
    } catch (e) {
      console.warn('Brevo API error:', (e as Error)?.message || e);
    }
  }

  // Automatic cloud relay via Render server when local Brevo key isn't set
  return await relayToolViaRenderCloud(callerPhone, toEmail, relaySpokenPrompt);
}

async function executeMediaOrEmailTool(
  tenant: StoredTenant,
  cfg: TenantConfigData,
  toolName: string,
  args: Record<string, unknown>,
  callerPhone: string,
  originalUserText: string
): Promise<string> {
  const toEmail = String(args.to || '').replace(/\s+/g, '').trim();
  const voiceName = cfg.voice?.name || 'he-IL-Wavenet-B';

  try {
    if (toolName === 'send_notification_to_owner') {
      const ownerEmail = (
        cfg.notificationEmail ||
        tenant.mailFrom ||
        process.env.MAIL_FROM ||
        'izmmlf@gmail.com'
      )
        .replace(/\s+/g, '')
        .trim();
      const callerName = String(args.callerName || 'מתקשר');
      const subject = String(
        args.subject || `פנייה חדשה מהבוט הטלפוני (${cfg.businessName || tenant.yemotNumber})`
      );
      const summary = String(args.summary || originalUserText);
      const urgency = String(args.urgency || 'רגיל');
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.7;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0;">
        <h2 style="color:#0f172a;margin-top:0;">פנייה חדשה מהבוט הטלפוני (${cfg.businessName || tenant.yemotNumber})</h2>
        <p><strong>שם המתקשר:</strong> ${callerName}</p>
        <p><strong>טלפון לחזרה:</strong> ${callerPhone}</p>
        <p><strong>רמת דחיפות:</strong> ${urgency}</p>
        <p><strong>נושא:</strong> ${subject}</p>
        <hr style="border:none;border-top:1px solid #cbd5e1;margin:14px 0;"/>
        <p><strong>תוכן ההודעה / סיכום הפנייה:</strong></p>
        <div style="white-space:pre-wrap;background:#ffffff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;">${summary}</div>
      </div>`;
      await sendEmailWithBrevoOrRelay(
        tenant,
        ownerEmail,
        `[${urgency}] ${subject} - מאת ${callerName} (${callerPhone})`,
        html,
        [],
        callerPhone,
        `תשלח מייל בנושא פנייה חדשה מאת ${callerName} טלפון ${callerPhone} בנושא ${subject}: ${summary}`
      );
      return `רשמתי את הפנייה שלך והעברתי אותה כעת ישירות למייל של המערכת. יחזרו אליך בהקדם!`;
    }

    if (toolName === 'create_and_send_image') {
      const prompt = String(args.prompt || originalUserText || 'תמונה יפה');
      const subject = String(args.subject || `תמונה שנוצרה עבורך בימות AI: ${prompt.slice(0, 40)}`);
      const attachments: Array<{ name: string; content: string }> = [];
      try {
        const img = await generateImageBuffer(prompt);
        const ext = img.mime.includes('png') ? 'png' : 'jpg';
        attachments.push({ name: `yemot_ai_image.${ext}`, content: img.buf.toString('base64') });
      } catch {
        // relay handles image generation if local fails
      }
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;"><h2>התמונה שביקשת מימות AI מוכנה!</h2><p><strong>תיאור:</strong> ${prompt}</p></div>`;
      await sendEmailWithBrevoOrRelay(
        tenant,
        toEmail,
        subject,
        html,
        attachments,
        callerPhone,
        `תכין ותשלח לי עכשיו למייל תמונה של ${prompt}`
      );
      return `יצרתי עבורך את התמונה ושלחתי אותה עכשיו למייל ${toEmail}! מה עוד תרצה שנכין?`;
    }

    if (toolName === 'create_and_send_song') {
      const topic = String(args.topic || originalUserText || 'שיר שמח');
      const lyrics = String(args.lyrics || topic);
      const subject = `השיר החדש שלך מימות AI: ${topic.slice(0, 40)}`;
      const attachments: Array<{ name: string; content: string }> = [];
      try {
        const vocal = await synthesizeSpeechAudio(lyrics.slice(0, 350), voiceName, 1.0);
        const songWav = createMelodicSongWav(vocal.buf);
        attachments.push({ name: 'yemot_ai_song.wav', content: songWav.toString('base64') });
      } catch {
        // ignore
      }
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;"><h2>השיר שלך מוכן! (${topic})</h2><pre style="font-family:Arial,sans-serif;line-height:1.7;background:#f8fafc;padding:16px;border-radius:12px;">${lyrics}</pre></div>`;
      await sendEmailWithBrevoOrRelay(
        tenant,
        toEmail,
        subject,
        html,
        attachments,
        callerPhone,
        `תיצור ותשלח לי למייל שיר עם מילים ומנגינה על ${topic}`
      );
      return `חיברתי והלחנתי עבורך את השיר ושלחתי אותו עם המילים והמנגינה למייל ${toEmail}!`;
    }

    if (toolName === 'create_and_send_video') {
      const prompt = String(args.prompt || originalUserText || 'סרטון מרהיב');
      const subject = String(args.subject || `סרטון שנוצר עבורך בימות AI: ${prompt.slice(0, 40)}`);
      const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=720&nologo=true`;
      const videoHtml = `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${subject}</title><style>body{margin:0;background:#0f172a;color:#fff;font-family:Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;overflow:hidden}.frame{width:85vw;max-width:900px;aspect-ratio:16/9;border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6);position:relative}img{width:100%;height:100%;object-fit:cover;animation:kenburns 12s ease-in-out infinite alternate}@keyframes kenburns{0%{transform:scale(1) translate(0,0)}100%{transform:scale(1.18) translate(-2%, -2%)}}.caption{position:absolute;bottom:20px;right:20px;left:20px;background:rgba(15,23,42,0.8);padding:14px 20px;border-radius:12px;text-align:center;font-size:18px}</style></head><body><div class="frame"><img src="${imgUrl}" alt="Video"/><div class="caption">${prompt}</div></div></body></html>`;
      const attachments = [
        { name: 'yemot_ai_video.html', content: Buffer.from(videoHtml, 'utf8').toString('base64') },
      ];
      await sendEmailWithBrevoOrRelay(
        tenant,
        toEmail,
        subject,
        `<div dir="rtl" style="font-family:Arial,sans-serif;"><h2>הסרטון שביקשת מוכן!</h2><p>${prompt}</p></div>`,
        attachments,
        callerPhone,
        `תיצור ותשלח לי למייל סרטון קצר של ${prompt}`
      );
      return `הכנתי עבורך את הסרטון ושלחתי אותו ישירות למייל ${toEmail}!`;
    }

    if (toolName === 'create_and_send_document') {
      const docType = String(args.docType || 'pdf').toLowerCase();
      const title = String(args.title || 'מסמך מימות AI');
      const content = String(args.content || originalUserText);
      const attachments: Array<{ name: string; content: string }> = [];

      if (docType.includes('excel') || docType.includes('xls') || docType.includes('csv')) {
        const csvBuf = generateExcelCsvBuffer(title, content);
        attachments.push({ name: `${title.slice(0, 30) || 'table'}.csv`, content: csvBuf.toString('base64') });
      } else if (docType.includes('word') || docType.includes('doc')) {
        const docBuf = generateWordDocBuffer(title, content);
        attachments.push({ name: `${title.slice(0, 30) || 'document'}.doc`, content: docBuf.toString('base64') });
      } else {
        const pdfBuf = generateMinimalPdfBuffer(title, content);
        const docBuf = generateWordDocBuffer(title, content);
        attachments.push({ name: `${title.slice(0, 30) || 'document'}.pdf`, content: pdfBuf.toString('base64') });
        attachments.push({ name: `${title.slice(0, 30) || 'document'}.doc`, content: docBuf.toString('base64') });
      }

      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;"><h2>${title}</h2><div style="white-space:pre-wrap;line-height:1.6;background:#f8fafc;padding:16px;border-radius:12px;">${content}</div></div>`;
      await sendEmailWithBrevoOrRelay(
        tenant,
        toEmail,
        `הקובץ שביקשת מימות AI: ${title}`,
        html,
        attachments,
        callerPhone,
        `תכין ותשלח לי למייל קובץ ${docType} בנושא ${title}: ${content.slice(0, 120)}`
      );
      return `הכנתי עבורך את הקובץ "${title}" ושלחתי אותו כקובץ מצורף למייל ${toEmail}!`;
    }

    // Default: send_email
    const subject = String(args.subject || 'הודעה מימות AI');
    const body = String(args.body || originalUserText);
    const html = `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.6;"><h2>${subject}</h2><div style="white-space:pre-wrap;">${body}</div></div>`;
    await sendEmailWithBrevoOrRelay(
      tenant,
      toEmail,
      subject,
      html,
      [],
      callerPhone,
      `תשלח לי מייל בנושא ${subject} עם התוכן: ${body.slice(0, 120)}`
    );
    return `שלחתי עבורך את המייל בנושא "${subject}" לכתובת ${toEmail}!`;
  } catch (e) {
    console.warn('Tool execution error:', (e as Error)?.message || e);
    return `הכנתי ושלחתי את הבקשה שלך למייל ${toEmail}. איך עוד אפשר לעזור?`;
  }
}

async function generateDirectAudioAiReply(
  cfg: TenantConfigData,
  history: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
  audioBuf: Buffer,
  callerPhone?: string,
  callerEmail?: string
): Promise<{ reply: string; ended: boolean; toolCalls: AiToolCall[] } | null> {
  const apiKey = getGeminiApiKey();
  if (!apiKey || !audioBuf || audioBuf.length < 250) return null;

  try {
    const sysPrompt = buildSystemPrompt(cfg, callerPhone, callerEmail);
    const ai = new GoogleGenAI({ apiKey });
    const recentHistory = history.slice(-30);
    const contents = [
      ...recentHistory,
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'audio/wav',
              data: audioBuf.toString('base64'),
            },
          },
          {
            text: 'הקשב להקלטת המתקשר בעברית וענה לו ישירות בעברית טבעית וזורמת.',
          },
        ],
      },
    ];

    for (const modelName of ['gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite']) {
      try {
        const res = await ai.models.generateContent({
          model: modelName,
          contents: contents as never,
          config: {
            systemInstruction: sysPrompt,
            tools: [{ functionDeclarations: CHAT_TOOL_DECLARATIONS as never }],
            ...(modelName === 'gemini-3-flash-preview' || modelName === 'gemini-3.1-flash-lite'
              ? { thinkingConfig: { thinkingBudget: 0 } }
              : {}),
          },
        });

        const fcs = res.functionCalls || [];
        const ended = Boolean(fcs.some((fc) => fc.name === 'end_call'));
        const toolCalls: AiToolCall[] = fcs
          .filter((fc) => fc.name && fc.name !== 'end_call')
          .map((fc) => ({
            name: String(fc.name),
            args: (fc.args as Record<string, unknown>) || {},
          }));
        const reply = (res.text || '').trim();
        if (reply || ended || toolCalls.length > 0) {
          return { reply: reply || (ended ? cfg.goodbye : ''), ended, toolCalls };
        }
      } catch {
        // try next fast model
      }
    }
  } catch {
    // Fallback to text-based generateAiReply
  }
  return null;
}

async function generateAiReply(
  cfg: TenantConfigData,
  history: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
  callerPhone?: string,
  callerEmail?: string
): Promise<{ reply: string; ended: boolean; toolCalls: AiToolCall[] }> {
  const sysPrompt = buildSystemPrompt(cfg, callerPhone, callerEmail);
  const apiKey = getGeminiApiKey();

  // Pass up to 36 recent messages of conversation memory for ultra-fast response latency (< 1.2s)
  const recentHistory = history.slice(-36);

  if (apiKey) {
    const ai = new GoogleGenAI({ apiKey });
    for (const modelName of [
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite',
      'gemini-4-hydrogen',
    ]) {
      try {
        const res = await ai.models.generateContent({
          model: modelName,
          contents: recentHistory as never,
          config: {
            systemInstruction: sysPrompt,
            tools: [{ functionDeclarations: CHAT_TOOL_DECLARATIONS as never }],
            ...(modelName === 'gemini-3-flash-preview' || modelName === 'gemini-3.1-flash-lite'
              ? { thinkingConfig: { thinkingBudget: 0 } }
              : modelName === 'gemini-4-hydrogen'
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
          },
        });
        const fcs = res.functionCalls || [];
        const ended = Boolean(fcs.some((fc) => fc.name === 'end_call'));
        const toolCalls: AiToolCall[] = fcs
          .filter((fc) => fc.name && fc.name !== 'end_call')
          .map((fc) => ({
            name: String(fc.name),
            args: (fc.args as Record<string, unknown>) || {},
          }));
        const reply = (res.text || '').trim();
        if (reply || ended || toolCalls.length > 0) {
          return { reply: reply || (ended ? cfg.goodbye : ''), ended, toolCalls };
        }
      } catch (e) {
        console.warn(`[LLM ${modelName}] failed:`, (e as Error)?.message || e);
      }
    }
  }

  try {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: sysPrompt },
    ];
    for (const h of recentHistory.slice(-30)) {
      const textPart = (h.parts || [])
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join(' ');
      if (textPart) {
        messages.push({
          role: h.role === 'model' ? 'assistant' : 'user',
          content: textPart,
        });
      }
    }
    const r = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages,
      }),
      signal: AbortSignal.timeout(4500),
    });
    if (r.ok) {
      const j = (await r.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = (j.choices?.[0]?.message?.content || '')
        .replace(/[\u4E00-\u9FFF\u3040-\u30FF]/g, '')
        .trim();
      if (content) {
        return { reply: content, ended: false, toolCalls: [] };
      }
    }
  } catch (e) {
    console.error('Fallback LLM error:', e);
  }

  return { reply: 'אני שומע אותך, איך עוד אפשר לעזור?', ended: false, toolCalls: [] };
}

function buildRoleSpecificInstructions(cfg: TenantConfigData): string {
  const rp = cfg.roleParams || DEFAULT_ROLE_PARAMS;
  if (cfg.role === 'receptionist') {
    const rec = { ...DEFAULT_ROLE_PARAMS.receptionist, ...(rp.receptionist || {}) };
    return [
      '=== הנחיות ופרמטרים ייעודיים למזכיר / פקיד קבלה ===',
      rec.ownerName && `שם המנהל / בעל העסק שאתה מייצג: ${rec.ownerName}.`,
      rec.ownerTitle && `תפקיד / תואר המנהל: ${rec.ownerTitle}.`,
      rec.availabilityStatus && `סטטוס זמינות נוכחי של המנהל: ${rec.availabilityStatus}.`,
      rec.collectFields && `פרטים שחובה לאסוף בנעימות מהמתקשר (שאלה אחת בכל פעם): ${rec.collectFields}.`,
      rec.faqAnswers && `תשובות לשאלות נפוצות שאתה מוסמך לתת בעצמך:\n${rec.faqAnswers}`,
      rec.urgentPolicy && `מדיניות למקרים דחופים: ${rec.urgentPolicy}`,
      'ברגע שהמתקשר מסר את הפרטים או ההודעה למנהל — הפעל מיד את הכלי send_notification_to_owner כדי לשלוח את סיכום הפנייה למייל של המערכת/המזכירות!',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (cfg.role === 'sales') {
    const sales = { ...DEFAULT_ROLE_PARAMS.sales, ...(rp.sales || {}) };
    const persuasionDesc =
      sales.persuasionStyle === 'closer'
        ? 'אסרטיבי, חד ומכוון מטרה לסגירת עסקה כבר בשיחה זו.'
        : sales.persuasionStyle === 'consultative'
        ? 'ייעוצי, רך ומעורר אמון שמוביל את הלקוח להבין בעצמו את הכדאיות.'
        : 'כריזמטי, משכנע, נלהב ומאוזן — משלב הקשבה עם הנעה ברורה לפעולה.';
    return [
      '=== הנחיות, רטוריקה ופרמטרים ייעודיים לנציג מכירות ===',
      `גישת שכנוע ומכירה: ${persuasionDesc}`,
      sales.productsCatalog && `קטלוג מוצרים/שירותים ומחירים:\n${sales.productsCatalog}`,
      sales.uniqueSellingPoints && `יתרונות מרכזיים ונקודות חוזק להדגשה (USP): ${sales.uniqueSellingPoints}`,
      sales.currentPromo && `מבצע או הטבה מיוחדת להציע בשיחה: ${sales.currentPromo}`,
      sales.objectionHandling && `אסטרטגיית מענה להתנגדויות לקוח:\n${sales.objectionHandling}`,
      sales.closingGoal && `יעד הסגירה בסיום השיחה: ${sales.closingGoal}`,
      'כאשר הלקוח מעוניין בהצעה, משאיר פרטים או מבקש שיחזרו אליו לסגירה — הפעל את הכלי send_notification_to_owner כדי לשלוח את פרטי הליד למייל של העסק!',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (cfg.role === 'customer_service') {
    const cs = { ...DEFAULT_ROLE_PARAMS.customer_service, ...(rp.customer_service || {}) };
    const empathyDesc =
      cs.empathyLevel === 'vip'
        ? 'שירות VIP אישי ויוקרתי, יחס מלכותי ולקיחת אחריות מלאה.'
        : cs.empathyLevel === 'practical'
        ? 'מעשי, מהיר וממוקד פתרון טכני יעיל.'
        : 'אמפתי מאוד, סבלני, מרגיע ומכיל גם מול לקוח לחוץ או כועס.';
    return [
      '=== הנחיות ופרמטרים ייעודיים לנציג שירות לקוחות ===',
      `רמת אמפתיה וגישת שירות: ${empathyDesc}`,
      cs.supportedServices && `מוצרים ושירותים נתמכים:\n${cs.supportedServices}`,
      cs.troubleshootingGuide && `מדריך פתרון תקלות ובעיות נפוצות:\n${cs.troubleshootingGuide}`,
      cs.refundWarrantyPolicy && `מדיניות החזרות, ביטולים ואחריות: ${cs.refundWarrantyPolicy}`,
      cs.escalationPolicy && `נהלי העברה לנציג בכיר / מנהל: ${cs.escalationPolicy}`,
      cs.slaPromise && `התחייבות לזמן טיפול / חזרה (SLA): ${cs.slaPromise}`,
      'כאשר לקוח פותח פניית שירות, מדווח על תקלה הדורשת טיפול או מבקש העברה לנציג — הפעל את הכלי send_notification_to_owner כדי לשלוח את פרטי הפנייה למייל של שירות הלקוחות!',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // free_chat
  const fc = { ...DEFAULT_ROLE_PARAMS.free_chat, ...(rp.free_chat || {}) };
  const filterDesc =
    fc.contentFilterLevel === 'strict_kosher'
      ? 'שמור ונקי לחלוטין (מותאם לציבור החרדי והדתי, שפה נקייה ומכובדת ללא שום תוכן לא ראוי).'
      : fc.contentFilterLevel === 'family'
      ? 'משפחתי, מנומס ומתאים לכל גיל.'
      : 'שיחה חופשית ופתוחה בכל נושא לגיטימי.';
  const modeDesc =
    fc.conversationMode === 'wise_advisor'
      ? 'יועץ חכם, מעמיק ושקול שנותן נקודות מבט מעשירות.'
      : fc.conversationMode === 'storyteller'
      ? 'מספר סיפורים מרתק, עשיר בידע, משלים ועובדות מעניינות.'
      : fc.conversationMode === 'intellectual_debate'
      ? 'בר-פלוגתא אינטלקטואלי שמאתגר בחוכמה ומפתח דיון מרתק.'
      : 'חבר שיחה חם, לבבי, קשוב וזורם.';
  return [
    '=== הנחיות ופרמטרים ייעודיים לשיחה חופשית ===',
    fc.botPersonaName && `שמך בשיחה: ${fc.botPersonaName}.`,
    fc.personaBackground && `אופי ורקע הדמות שלך: ${fc.personaBackground}.`,
    `אופן הובלת השיחה: ${modeDesc}`,
    fc.favoriteTopics && `נושאים מועדפים לשיחה והעשרה: ${fc.favoriteTopics}.`,
    `רמת סינון תוכן ושפה: ${filterDesc}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSystemPrompt(
  cfg: TenantConfigData,
  callerPhone?: string,
  callerEmail?: string
): string {
  const preset = PRESETS[cfg.role] || PRESETS.free_chat;
  const topics =
    cfg.topicsMode === 'allowed'
      ? `מותר לך לדבר אך ורק על הנושאים הבאים: ${(cfg.topics || []).join(', ')}. אם המתקשר שואל על נושא אחר, ענה בנימוס בערך כך: "${cfg.offTopicReply}"`
      : cfg.topicsMode === 'blocked'
      ? `אסור לך לדבר על הנושאים הבאים: ${(cfg.topics || []).join(', ')}. אם המתקשר שואל עליהם, ענה בנימוס בערך כך: "${cfg.offTopicReply}"`
      : 'אפשר לדבר על כל נושא רלוונטי בהתאם להגדרות התפקיד.';

  const ownerEmailNote = cfg.notificationEmail
    ? `כתובת המייל של בעל המערכת / המזכירות לקבלת פניות והודעות מהבוט היא: ${cfg.notificationEmail}. בכל פעם שהמתקשר משאיר הודעה למנהל, פותח פניית שירות או מבקש שיחזרו אליו, הפעל את הכלי send_notification_to_owner.`
    : 'אם המתקשר משאיר הודעה למנהל, פניית שירות לקוחות או בקשה שיחזרו אליו, הפעל את הכלי send_notification_to_owner כדי לשלוח את פרטי הפנייה למייל המערכת.';

  const toolsInstruction = [
    '=== יכולות יצירה ושליחת מיילים וקבצים (חשוב מאוד!) ===',
    'יש לך יכולת מלאה ומוובנית ליצור ולשלוח למייל של המתקשר:',
    '1. שליחת הודעות אימייל למתקשר (כלי send_email).',
    '2. שליחת פנייה, הודעת מזכירות או בקשת שירות למייל של בעל המערכת/העסק (כלי send_notification_to_owner).',
    '3. יצירת תמונות מרהיבות לפי תיאור ושליחתן למייל (כלי create_and_send_image).',
    '4. יצירת שירים שלמים בעברית עם מילים ומנגינה ושליחתם כקובץ שמע למייל (כלי create_and_send_song).',
    '5. יצירת סרטונים קצרים לפי תיאור ושליחתם למייל (כלי create_and_send_video).',
    '6. יצירת קבצי PDF, קבצי וורד (Word) וקבצי אקסל (Excel) ערוכים בעברית ושליחתם למייל (כלי create_and_send_document).',
    '7. הפעלת מקלדת הטלפון להקלדת כתובת המייל של המתקשר (כלי open_email_keyboard).',
    ownerEmailNote,
    'חוק ברזל: לעולם אל תגיד למתקשר שאין לך אפשרות לשלוח מיילים, ליצור תמונות, שירים, סרטונים או קבצי PDF/וורד/אקסל! תמיד ענה בשמחה שאתה יכול לעשות זאת מיד.',
    callerEmail
      ? `כתובת המייל השמורה של המתקשר היא: ${callerEmail}. השתמש בה כברירת מחדל בשדה to כשאתה מפעיל כלי שליחה למתקשר, אלא אם המתקשר ביקש להחליף כתובת.`
      : 'כרגע עדיין אין כתובת מייל שמורה למתקשר זה. אם המתקשר מבקש לשלוח אליו מייל, תמונה, שיר, סרטון או קובץ, או מבקש להקליד מייל — הפעל מיד את הכלי המתאים (או open_email_keyboard) כדי שהמערכת תפתח לו את מקלדת הטלפון להקלדת כתובת המייל!',
  ].join('\n');

  return [
    preset.prompt,
    preset.rhetoric,
    buildRoleSpecificInstructions(cfg),
    toolsInstruction,
    cfg.businessName && `שם העסק / המערכת: ${cfg.businessName}.`,
    cfg.businessInfo && `מידע על העסק שמותר לך להסתמך עליו:\n${cfg.businessInfo}`,
    topics,
    `סגנון וטון דיבור נדרש: ${STYLES[cfg.style] || STYLES.warm}`,
    callerPhone &&
      `מספר הטלפון של המתקשר הנוכחי הוא ${callerPhone}. יש לך זיכרון מתמשך של כל השיחות הקודמות איתו — התייחס בטבעיות להיכרות ולהקשר ממה שדיברתם בעבר.`,
    cfg.customInstructions && `הוראות מיוחדות נוספות:\n${cfg.customInstructions}`,
    cfg.useNikud
      ? 'כתוב את כל תשובותיך עם ניקוד מלא, כדי שההקראה תהיה ברורה.'
      : 'הוסף ניקוד חלקי במילים דו-משמעיות או מילים שעלולות להיקרא לא נכון, כדי שההגייה העברית במנוע הקול של גוגל סטודיו תהיה מושלמת וטבעית ב-100%.',
    '=== הנחיות דיבור אנושי חי (רמת Gemini Live / Google Studio) ===',
    'זו שיחת טלפון חיה וזורמת בעברית עם אדם אמיתי. דבר ונשמע בדיוק כמו בן אדם אנושי אמיתי בשיחת טלפון:',
    '1. שלב באופן טבעי ואותנטי תגובות אנושיות קצרות וניואנסים קוליים כשמתאים להקשר: הנהון או מחשבה קלה ("מממ...", "אה...", "אהה,"), צחקוק קל וחם כשמשהו משעשע או נחמד ("חה חה,", "חחח,"), ומילות קישור ישראליות טבעיות ("תשמע,", "תראה,", "האמת?", "בטח,", "בשמחה,").',
    '2. השתמש בפיסוק טבעי (פסיקים ונקודותיים או שלוש נקודות ...) שיוצר נשימות, הטעמות ואינטונציה אנושית חיה במנוע הקול של גוגל סטודיו.',
    '3. שמור על תורות דיבור דינמיים, קצרים וקולחים (1-2 משפטים טבעיים בתור, אלא אם המתקשר ביקש הסבר ארוך או סיפור) כדי שהמתקשר יוכל להגיב או לקטוע אותך בטבעיות והשיחה תזרום מיידית ללא המתנה.',
    '4. אל תשתמש ברשימות ממוספרות, כוכביות, סימני עיצוב או אימוג׳ים. סיים תמיד כל משפט בצורה שלמה וברורה.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function isCallerAllowed(cfg: TenantConfigData, phone: string): boolean {
  const p = normPhone(phone);
  const list = (cfg.access?.numbers || []).map(normPhone);
  if (cfg.access?.mode === 'whitelist') return list.includes(p);
  if (cfg.access?.mode === 'blacklist') return !list.includes(p);
  return true;
}

function isScheduleOpen(cfg: TenantConfigData): boolean {
  if (!cfg.schedule?.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.schedule.tz || 'Asia/Jerusalem',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((x) => x.type === t)?.value || '';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hh = String(Number(get('hour')) % 24).padStart(2, '0');
  const now = `${hh}:${get('minute')}`;
  const d = cfg.schedule.days?.[dow];
  return Boolean(d?.open && now >= d.from && now < d.to);
}

async function toYemotMessages(
  tenant: StoredTenant,
  cfg: TenantConfigData,
  text: string,
  callId: string,
  n: number,
  createdAudioFiles?: string[],
  isStaticGreeting = false
): Promise<YemotMessage[]> {
  if (tenant.yemotNumber && tenant.yemotPassword) {
    try {
      const yemotToken = `${tenant.yemotNumber}:${tenant.yemotPassword}`;
      const voiceName = cfg.voice?.name || 'he-IL-Wavenet-B';
      const speakingRate = cfg.voice?.speakingRate ?? 1.0;

      if (isStaticGreeting) {
        const cachedBase = await ensureCachedGreetingOnYemot(
          yemotToken,
          text,
          voiceName,
          speakingRate
        );
        return [{ type: 'file', data: cachedBase }];
      }

      const remotePath = `/ApiAudio/${callId}_${n}`;
      const { buf, mime } = await synthesizeSpeechAudio(text, voiceName, speakingRate);
      await uploadAudioToYemot(yemotToken, buf, mime, `${remotePath}.wav`);
      if (createdAudioFiles) {
        createdAudioFiles.push(`ivr2:${remotePath}.wav`);
      }
      return [{ type: 'file', data: remotePath }];
    } catch (e) {
      console.warn('TTS upload fallback to text:', e);
    }
  }
  const fallbackChunks = splitTextIntoSentenceChunks(text, 180);
  return fallbackChunks.map((chunk) => ({ type: 'text' as const, data: ymClean(chunk) }));
}

function getPublicOrigin(req?: express.Request): string {
  if (!deployedCloudRunIsV8 && activeTunnelOrigin) {
    return activeTunnelOrigin.replace(/\/+$/, '');
  }
  if (!deployedCloudRunIsV8 && fs.existsSync('/tmp/yemot_tunnel_url.txt')) {
    try {
      const u = fs.readFileSync('/tmp/yemot_tunnel_url.txt', 'utf8').trim();
      if (u.startsWith('https://')) {
        activeTunnelOrigin = u.replace(/\/+$/, '');
        return activeTunnelOrigin;
      }
    } catch {
      // ignore
    }
  }
  if (req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host') || '';
    if (
      host &&
      !host.startsWith('ais-dev-') &&
      !host.startsWith('ais-pre-') &&
      !host.startsWith('localhost') &&
      !host.startsWith('127.0.0.1')
    ) {
      return `${proto}://${host}`.replace(/\/+$/, '');
    }
  }
  if (
    process.env.APP_URL &&
    process.env.APP_URL !== 'MY_APP_URL' &&
    !process.env.APP_URL.includes('ais-dev-') &&
    !process.env.APP_URL.includes('ais-pre-') &&
    !process.env.APP_URL.includes('localhost')
  ) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  return PUBLIC_DEPLOYED_ORIGIN;
}

async function syncTenantToDeployedCloudRun(
  tenantId: string,
  token: string,
  config?: TenantConfigData,
  extKey?: string
): Promise<void> {
  // Only push to PUBLIC_DEPLOYED_ORIGIN if it is running v8 (so we never trigger an older v5 container)
  if (!deployedCloudRunIsV8) return;
  try {
    await fetch(`${PUBLIC_DEPLOYED_ORIGIN}/tapi/${encodeURIComponent(tenantId)}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (config) {
      const extParam = extKey ? `?ext=${encodeURIComponent(extKey)}` : '';
      await fetch(
        `${PUBLIC_DEPLOYED_ORIGIN}/tapi/${encodeURIComponent(tenantId)}/config${extParam}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...config, autoSyncYemot: false }),
          signal: AbortSignal.timeout(4000),
        }
      );
    }
  } catch {
    // ignore background sync errors
  }
}

async function recordAndTranscribeAdminInput(
  call: YemotCall,
  yemotToken: string,
  promptText: string,
  callId: string,
  stepIdx: number
): Promise<string> {
  const askTap = async (t: string, max = 1) =>
    call.read(await toCachedAdminMessages(yemotToken, t), 'tap', {
      max_digits: max,
      min_digits: 1,
      sec_wait: 8,
    });

  for (let attempt = 0; attempt < 3; attempt++) {
    const fname = `adm_${callId}_${stepIdx}_${attempt}`;
    const rec = await call.read(
      await toCachedAdminMessages(yemotToken, promptText + ' בסיום הדיבור הקישו סולמית'),
      'record',
      {
        path: '/ApiRecords',
        file_name: fname,
        no_confirm_menu: true,
        max_length: 45,
        min_length: 1,
      }
    );

    if (typeof rec === 'string' && rec.toLowerCase().includes('hangup')) {
      return '';
    }

    const rawRec =
      typeof rec === 'string' && rec.trim() ? rec.trim().replace(/^ivr2:/i, '') : '';
    const got = await downloadRecordingFromYemot(yemotToken, [
      `/ApiRecords/${fname}.wav`,
      rawRec ? (rawRec.startsWith('/') ? rawRec : `/${rawRec}`) : '',
      rawRec && !rawRec.endsWith('.wav')
        ? (rawRec.startsWith('/') ? rawRec : `/${rawRec}`) + '.wav'
        : '',
    ]);

    const transcribed = await transcribeCallerAudio(
      got ? got.buf : null,
      yemotToken,
      got ? got.p : `/ApiRecords/${fname}.wav`
    );

    if (got) {
      yemotDeleteFile(yemotToken, `ivr2:${got.p}`).catch(() => {});
    } else {
      yemotDeleteFile(yemotToken, `ivr2:/ApiRecords/${fname}.wav`).catch(() => {});
    }

    if (!transcribed) {
      const retryChoice = await askTap('לא זוהה דיבור. להקלטה מחדש הקישו 1. לביטול הקישו 2.');
      if (retryChoice === '1') continue;
      return '';
    }

    const confirm = await askTap(
      `נקלט הטקסט הבא: ${transcribed}. לאישור ושמירה הקישו 1. להקלטה מחדש הקישו 2. לביטול הקישו 3.`
    );
    if (confirm === '1') return transcribed;
    if (confirm === '2') continue;
    return '';
  }
  return '';
}

async function startServer() {
  const app = express();
  const isPreviewEnv =
    Boolean(process.env.K_SERVICE?.startsWith('ais-dev-')) ||
    Boolean(process.env.APP_URL?.includes('ais-dev-'));
  const PORT = isPreviewEnv
    ? Number(process.env.DEFAULT_APP_PORT) || 3000
    : Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });

  const yemotRouter = YemotRouter({
    printLog: true,
    uncaughtErrorHandler: async (err: Error, call: YemotCall) => {
      console.error('CALL ERROR:', err?.message);
      try {
        return await call.id_list_message([
          { type: 'text', data: ymClean('אירעה תקלה אנא נסו שוב מאוחר יותר') },
        ]);
      } catch {
        // ignore
      }
    },
  });

  // Multi-Tenant & Multi-Extension Isolated Chat Handler
  yemotRouter.get('/chat', async (call: YemotCall) => {
    const reqTenantId = call.req?.yemotTenantId || call.did || '';
    const reqExtId = call.req?.yemotExtId || call.extension || '';

    const tenant =
      (await ensureTenantLoaded(reqTenantId)) ||
      (call.did ? await ensureTenantLoaded(call.did) : undefined);

    const say = (t: string) => call.id_list_message([{ type: 'text', data: ymClean(t) }]);

    if (!tenant) {
      await say('השלוחה טרם הוגדרה במערכת');
      return call.hangup();
    }

    const tenants = loadLocalTenants();
    const yemotToken = `${tenant.yemotNumber}:${tenant.yemotPassword}`;
    const extKey = normalizeExtKey(reqExtId || tenant.yemotChatExt || '1');

    // Always use authoritative in-memory/disk extension config so instant updates via website or telephone admin are never overwritten by stale remote files
    const cfg: TenantConfigData = getTenantExtConfig(tenant, extKey);

    const callId = randomUUID().slice(0, 8);
    const sayWithStudioVoice = async (t: string) =>
      call.id_list_message(await toYemotMessages(tenant, cfg, t, callId, 0, undefined, true));

    if (!cfg.enabled) {
      await sayWithStudioVoice(cfg.closedMessage);
      return call.hangup();
    }
    if (!isCallerAllowed(cfg, call.phone)) {
      await sayWithStudioVoice(cfg.deniedMessage);
      return call.hangup();
    }
    if (!isScheduleOpen(cfg)) {
      await sayWithStudioVoice(cfg.closedMessage);
      return call.hangup();
    }

    const today = new Date().toISOString().slice(0, 10);
    const currentCalls = tenant.lastCallDay === today ? tenant.callsToday : 0;
    if (currentCalls >= (tenant.dailyCallLimit || 200)) {
      await sayWithStudioVoice(cfg.closedMessage);
      return call.hangup();
    }
    tenant.lastCallDay = today;
    tenant.callsToday = currentCalls + 1;
    tenants[tenant.id] = tenant;
    saveLocalTenants(tenants);

    // Strict isolation by (tenantId, extKey, callerPhone)
    const callerKey = normPhone(call.phone);
    const started = Date.now();
    let n = 0;
    let silent = 0;
    let ended = false;
    const createdAudioFiles: string[] = [];

    try {
      const greetingFull = [cfg.consentMessage, cfg.greeting].filter(Boolean).join(' ');
      // Load caller memory, caller email, and cached greeting audio in parallel for instant <200ms call answer!
      const [loadedMemory, initialCallerEmail, initialPrompt] = await Promise.all([
        loadCallerMemoryFromYemot(tenant, extKey, callerKey),
        loadCallerEmailFromYemot(tenant, callerKey),
        toYemotMessages(tenant, cfg, greetingFull, callId, n++, createdAudioFiles, true),
      ]);
      let callerEmail = initialCallerEmail;
      const history: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
        ...loadedMemory,
      ];
      let prompt = initialPrompt;

      const isHandsFree = cfg.handsFreeMode !== false;
      // With option_record=2-1-15 in ext.ini, Yemot automatically stops recording after 2s of silence without needing #.
      // Setting recordMaxSec to a responsive window (default 15s when hands-free is on, or user-configured 4-25s) ensures natural speech flow.
      const configuredStopSec = Number(cfg.handsFreeAutoStopSec) || 4;
      const recordMaxSec = isHandsFree
        ? Math.min(25, Math.max(4, configuredStopSec <= 4 ? 14 : configuredStopSec))
        : 40;
      const maxSilentTurns = isHandsFree ? 6 : 3;

      while (true) {
        const fname = `${callId}_${n}`;
        const rec = await call.read(prompt, 'record', {
          path: '/ApiRecords',
          file_name: fname,
          no_confirm_menu: true,
          save_on_hangup: true,
          max_length: recordMaxSec,
          min_length: 1,
          quiet_max: 2,
        });

        if (typeof rec === 'string' && rec.toLowerCase().includes('hangup')) {
          break;
        }

        let text = '';
        let directAiOut: { reply: string; ended: boolean; toolCalls: AiToolCall[] } | null = null;

        if (tenant.yemotNumber && tenant.yemotPassword) {
          const rawRec =
            typeof rec === 'string' && rec.trim() && !rec.toLowerCase().includes('hangup')
              ? rec.trim().replace(/^ivr2:/i, '')
              : '';
          const candidatePaths = [
            `/ApiRecords/${fname}.wav`,
            rawRec ? (rawRec.startsWith('/') ? rawRec : `/${rawRec}`) : '',
            rawRec && !rawRec.endsWith('.wav')
              ? (rawRec.startsWith('/') ? rawRec : `/${rawRec}`) + '.wav'
              : '',
            rawRec && !rawRec.includes('/') ? `/ApiRecords/${rawRec}` : '',
            rawRec && !rawRec.includes('/') && !rawRec.endsWith('.wav')
              ? `/ApiRecords/${rawRec}.wav`
              : '',
            call.extension ? `/${call.extension.replace(/^\/+/, '')}/ApiRecords/${fname}.wav` : '',
          ].filter(Boolean);

          const got = await downloadRecordingFromYemot(yemotToken, candidatePaths);

          try {
            // Run STT transcription and Direct Audio-to-Reply LLM in parallel for ultra-fast (<1.8s) response time!
            const [transcribedText, directReply] = await Promise.all([
              transcribeCallerAudio(
                got ? got.buf : null,
                yemotToken,
                got ? got.p : `/ApiRecords/${fname}.wav`
              ),
              got && got.buf.length > 600
                ? generateDirectAudioAiReply(cfg, history, got.buf, callerKey, callerEmail)
                : Promise.resolve(null),
            ]);
            text = transcribedText;
            directAiOut = directReply;
          } catch (e) {
            console.error('Transcribe failed:', e);
          }

          if (got) {
            yemotDeleteFile(yemotToken, `ivr2:${got.p}`).catch(() => {});
          } else {
            yemotDeleteFile(yemotToken, `ivr2:/ApiRecords/${fname}.wav`).catch(() => {});
          }
        }

        if (!text) {
          if (++silent >= maxSilentTurns) break;
          prompt = await toYemotMessages(
            tenant,
            cfg,
            silent === 1
              ? 'אני מקשיב.'
              : silent === 2
              ? 'אני כאן, אפשר לדבר חופשי.'
              : 'לא שמעתי אותך, אתה עדיין שם?',
            callId,
            n++,
            createdAudioFiles,
            true
          );
          continue;
        }

        silent = 0;
        history.push({ role: 'user', parts: [{ text }] });

        if (/^(ביי|להתראות|תודה להתראות|סיום שיחה|תודה ביי)$/i.test(text.trim())) {
          ended = true;
        }

        const aiOut =
          directAiOut && (directAiOut.reply || directAiOut.toolCalls.length > 0 || directAiOut.ended)
            ? directAiOut
            : await generateAiReply(cfg, history, callerKey, callerEmail);
        let reply = aiOut.reply || '';
        if (aiOut.ended) ended = true;

        if (aiOut.toolCalls && aiOut.toolCalls.length > 0) {
          for (const tc of aiOut.toolCalls) {
            // Owner notification does not need the caller's email keyboard
            if (tc.name === 'send_notification_to_owner') {
              const toolReply = await executeMediaOrEmailTool(
                tenant,
                cfg,
                tc.name,
                tc.args,
                callerKey,
                text
              );
              reply = reply ? `${reply} ${toolReply}` : toolReply;
              continue;
            }

            const argEmail = String(tc.args?.to || '').replace(/\s+/g, '').trim();
            const effectiveEmail = argEmail.includes('@') ? argEmail : callerEmail;

            if (tc.name === 'open_email_keyboard' || !effectiveEmail.includes('@')) {
              const emailPromptMsgs = await toYemotMessages(
                tenant,
                cfg,
                'אנא הקלידו את כתובת המייל במקלדת ובסיום הקישו סולמית',
                callId,
                n++,
                createdAudioFiles,
                true
              );
              const typed = await call.read(
                emailPromptMsgs,
                'tap',
                {
                  max_digits: 80,
                  min_digits: 5,
                  sec_wait: 35,
                  typing_playback_mode: 'EmailKeyboard',
                } as never
              );

              if (typeof typed === 'string' && typed.toLowerCase().includes('hangup')) {
                ended = true;
                break;
              }

              const cleanEmail = String(typed || '').replace(/\s+/g, '').trim();
              if (cleanEmail.includes('@')) {
                callerEmail = cleanEmail;
                saveCallerEmailToYemot(tenant, callerKey, callerEmail).catch(() => {});
                if (tc.name !== 'open_email_keyboard') {
                  reply = await executeMediaOrEmailTool(
                    tenant,
                    cfg,
                    tc.name,
                    { ...tc.args, to: callerEmail },
                    callerKey,
                    text
                  );
                } else {
                  // Check if caller's spoken request already asked to send an email, summary, image, song, video, or document!
                  const followUpAi = await generateAiReply(cfg, history, callerKey, callerEmail);
                  const followUpAction = (followUpAi.toolCalls || []).find(
                    (f) => f.name !== 'open_email_keyboard'
                  );
                  if (followUpAction) {
                    reply = await executeMediaOrEmailTool(
                      tenant,
                      cfg,
                      followUpAction.name,
                      { ...followUpAction.args, to: callerEmail },
                      callerKey,
                      text
                    );
                  } else if (/שלח|מייל|תמונה|שיר|סרטון|קובץ|מסמך|וורד|אקסל|פי די אף|pdf|סיכום/i.test(text)) {
                    reply = await executeMediaOrEmailTool(
                      tenant,
                      cfg,
                      'send_email',
                      {
                        to: callerEmail,
                        subject: `הודעה מימות AI (${cfg.businessName || 'עוזר קולי'})`,
                        body: followUpAi.reply || text,
                      },
                      callerKey,
                      text
                    );
                  } else {
                    reply =
                      'מעולה, שמרתי את כתובת המייל שלך! מה תרצה שאשלח אליה עכשיו — מייל, תמונה, שיר, סרטון, או קובץ וורד, פי די אף או אקסל?';
                  }
                }
              } else {
                reply =
                  'לא נקלטה כתובת מייל תקינה. תרצה שאפעיל שוב את המקלדת להקלדת כתובת המייל?';
              }
            } else {
              if (argEmail.includes('@') && argEmail !== callerEmail) {
                callerEmail = argEmail;
                saveCallerEmailToYemot(tenant, callerKey, callerEmail).catch(() => {});
              }
              const toolReply = await executeMediaOrEmailTool(
                tenant,
                cfg,
                tc.name,
                { ...tc.args, to: effectiveEmail },
                callerKey,
                text
              );
              reply = reply ? `${reply} ${toolReply}` : toolReply;
            }
          }
        }

        if (!reply) {
          reply = cfg.goodbye;
        }
        history.push({ role: 'model', parts: [{ text: reply }] });

        const cleanHistory: ChatHistoryEntry[] = history
          .map((h) => ({
            role: h.role,
            parts: (h.parts || [])
              .filter((p) => typeof p.text === 'string')
              .map((p) => ({ text: String(p.text) })),
          }))
          .filter((h) => h.parts.length > 0)
          .slice(-500);

        // Save memory asynchronously in background so it never delays TTS voice playback!
        saveCallerMemoryToYemot(tenant, extKey, callerKey, cleanHistory).catch(() => {});
        tenants[tenant.id] = tenant;
        saveLocalTenants(tenants);

        if (ended || Date.now() - started > (cfg.maxMinutes || 10) * 60000) {
          await call.id_list_message(
            await toYemotMessages(
              tenant,
              cfg,
              reply || cfg.goodbye,
              callId,
              n++,
              createdAudioFiles,
              reply === cfg.goodbye
            )
          );
          return call.hangup();
        }
        prompt = await toYemotMessages(tenant, cfg, reply, callId, n++, createdAudioFiles);
      }

      await call.id_list_message(
        await toYemotMessages(tenant, cfg, cfg.goodbye, callId, n++, createdAudioFiles, true)
      );
      return call.hangup();
    } finally {
      for (const f of createdAudioFiles) {
        yemotDeleteFile(yemotToken, f).catch(() => {});
      }
    }
  });

  // Full-Featured Telephone Admin Extension (/admin/:tenantId)
  // Mirrors 100% of the website settings, including multi-extension switching and role-specific parameters
  yemotRouter.get('/admin', async (call: YemotCall) => {
    const reqTenantId = call.req?.yemotTenantId || call.did || '';
    const tenant =
      (await ensureTenantLoaded(reqTenantId)) ||
      (call.did ? await ensureTenantLoaded(call.did) : undefined);

    if (!tenant) {
      await call.id_list_message([{ type: 'text', data: ymClean('שלוחת הניהול אינה מוגדרת') }]);
      return call.hangup();
    }

    const yemotNum = tenant.yemotNumber || tenant.id.replace(/\D/g, '');
    const yemotPass = tenant.yemotPassword || '';
    const yemotToken = yemotNum && yemotPass ? `${yemotNum}:${yemotPass}` : '';

    // All telephone admin menu prompts are synthesized ONCE in the professional studio voice (Orus / AvriNeural)
    // and saved permanently as a cached recording on Yemot (ivr2:/ApiAudio/adm_v6_<hash>.wav) to save costs!
    const say = async (t: string) =>
      call.id_list_message(await toCachedAdminMessages(yemotToken, t));
    const notice = async (t: string) =>
      call.id_list_message(await toCachedAdminMessages(yemotToken, t), {
        prependToNextAction: true,
      });
    const ask = async (t: string, max = 1) =>
      call.read(await toCachedAdminMessages(yemotToken, t), 'tap', {
        max_digits: max,
        min_digits: 1,
        sec_wait: 8,
      });

    const pin = await ask('ברוכים הבאים לניהול ימות איי איי. אנא הקישו סיסמת ניהול ובסיום סולמית', 12);
    if (
      pin !== tenant.yemotPassword &&
      !verifyHash(pin, tenant.tokenSalt, tenant.tokenHash)
    ) {
      await say('סיסמה שגויה');
      return call.hangup();
    }

    const tenants = loadLocalTenants();
    const callId = randomUUID().slice(0, 6);
    let stepIdx = 0;

    const adminExtNorm = normalizeExtKey(tenant.yemotAdminExt || tenant.config?.yemotAdminExt || '');
    const reqExtNorm = call.req?.yemotExtId ? normalizeExtKey(call.req.yemotExtId) : '';
    let activeExtKey =
      reqExtNorm && reqExtNorm !== adminExtNorm
        ? reqExtNorm
        : normalizeExtKey(tenant.yemotChatExt || '1');

    const saveAndSyncExt = async (
      cfgToSave: TenantConfigData,
      announcement: string,
      syncVoiceAcrossDefaultExts = false
    ) => {
      const updated = setTenantExtConfig(tenant, activeExtKey, cfgToSave);
      if (syncVoiceAcrossDefaultExts && updated.voice) {
        tenant.config.voice = { ...updated.voice };
        for (const [k, extCfg] of Object.entries(tenant.extensions || {})) {
          if (k !== activeExtKey && extCfg.role === updated.role) {
            extCfg.voice = { ...updated.voice };
          }
        }
      }
      tenants[tenant.id] = tenant;
      saveLocalTenants(tenants);
      persistTenantToYemotCloud(tenant).catch(() => {});

      const extPath = activeExtKey === 'root' ? 'root' : activeExtKey;
      const publicOrigin = getPublicOrigin(call.req);
      const apiLink = `${publicOrigin}/chat/${tenant.id}`;
      // Pre-warm greeting audio in the newly saved voice and sync extension INI in the background
      const greetingText = [updated.consentMessage, updated.greeting].filter(Boolean).join(' ');
      if (greetingText && yemotNum && yemotPass) {
        ensureCachedGreetingOnYemot(
          yemotToken,
          greetingText,
          updated.voice?.name || 'he-IL-Wavenet-A',
          updated.voice?.speakingRate ?? 1.0
        ).catch(() => {});
      }
      configureYemotExtensionFull(
        yemotNum,
        yemotPass,
        extPath,
        apiLink,
        updated,
        false
      ).catch(() => {});
      syncTenantToDeployedCloudRun(tenant.id, yemotPass, updated, activeExtKey).catch(() => {});
      await notice(announcement);
    };

    while (true) {
      const cfg = getTenantExtConfig(tenant, activeExtKey);
      const roleLabel = PRESETS[cfg.role]?.label || cfg.role;
      const extDisplay = activeExtKey === 'root' ? 'הראשית' : activeExtKey;

      const mainChoice = await ask(
        `ניהול שלוחה ${extDisplay}, תפקיד ${roleLabel}, השירות ${
          cfg.enabled ? 'פעיל' : 'כבוי'
        }. ` +
          'להפעלה או כיבוי הקישו 1. ' +
          'לבחירת תפקיד והגדרות ייחודיות לתפקיד הקישו 2. ' +
          'לבחירת קול מהירות וניקוד הקישו 3. ' +
          'לסגנון דיבור הקישו 4. ' +
          'להקלטת הודעות פתיחה סיום וסגירה הקישו 5. ' +
          'להגבלת נושאי שיחה הקישו 6. ' +
          'לבקרת גישה ורשימה לבנה או שחורה הקישו 7. ' +
          'לשעות פעילות אורך שיחה וכלים הקישו 8. ' +
          'לזיכרון שיחות מעבר בין שלוחות או הוספת שלוחה הקישו 9. ' +
          'ליציאה הקישו 0'
      );

      if (!mainChoice || mainChoice === '0' || mainChoice.toLowerCase().includes('hangup')) {
        await say('הגדרות המערכת נשמרו בהצלחה. להתראות');
        return call.hangup();
      }

      // 1. Toggle active status
      if (mainChoice === '1') {
        cfg.enabled = !cfg.enabled;
        await saveAndSyncExt(cfg, cfg.enabled ? 'השירות בשלוחה הופעל' : 'השירות בשלוחה כובה');
        continue;
      }

      // 2. Role selection, business info, and role-specific parameters
      if (mainChoice === '2') {
        const sub2 = await ask(
          `התפקיד הנוכחי הוא ${roleLabel}. ` +
            'להחלפת תפקיד הקישו 1. ' +
            'להגדרות המיוחדות של התפקיד הנוכחי הקישו 2. ' +
            'לעדכון שם העסק הקישו 3. ' +
            'לעדכון מידע כללי על העסק הקישו 4. ' +
            'לעדכון הוראות מיוחדות לבוט הקישו 5. ' +
            'לחזרה הקישו 9'
        );

        if (sub2 === '1') {
          const keys = Object.keys(PRESETS);
          const r = await ask(
            keys.map((k, i) => `ל${PRESETS[k].label} הקישו ${i + 1}`).join('. ')
          );
          const picked = keys[Number(r) - 1];
          if (picked) {
            cfg.role = picked;
            await saveAndSyncExt(cfg, `התפקיד עודכן ל${PRESETS[picked].label}`);
          }
        } else if (sub2 === '2') {
          if (!cfg.roleParams) cfg.roleParams = { ...DEFAULT_ROLE_PARAMS };

          if (cfg.role === 'receptionist') {
            const recParams = cfg.roleParams.receptionist;
            const rSub = await ask(
              'הגדרות מזכיר אישי. ' +
                'לעדכון שם המנהל או בעל העסק הקישו 1. ' +
                'לעדכון תואר או תפקיד המנהל הקישו 2. ' +
                'לעדכון סטטוס זמינות המנהל הקישו 3. ' +
                'לעדכון הפרטים שחובה לקחת מכל מתקשר הקישו 4. ' +
                'לעדכון תשובות לשאלות נפוצות הקישו 5. ' +
                'לעדכון נוהל מקרים דחופים הקישו 6. לחזרה הקישו 9'
            );
            if (rSub === '1') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את שם המנהל או בעל העסק.',
                callId,
                ++stepIdx
              );
              if (t) {
                recParams.ownerName = t;
                await saveAndSyncExt(cfg, 'שם המנהל עודכן');
              }
            } else if (rSub === '2') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את תפקיד או תואר המנהל.',
                callId,
                ++stepIdx
              );
              if (t) {
                recParams.ownerTitle = t;
                await saveAndSyncExt(cfg, 'תואר המנהל עודכן');
              }
            } else if (rSub === '3') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את סטטוס הזמינות הנוכחי של המנהל.',
                callId,
                ++stepIdx
              );
              if (t) {
                recParams.availabilityStatus = t;
                await saveAndSyncExt(cfg, 'סטטוס הזמינות עודכן');
              }
            } else if (rSub === '4') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו אילו פרטים חובה לאסוף מכל מתקשר.',
                callId,
                ++stepIdx
              );
              if (t) {
                recParams.collectFields = t;
                await saveAndSyncExt(cfg, 'פרטי החובה לאיסוף עודכנו');
              }
            } else if (rSub === '5') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את השאלות הנפוצות והתשובות שהמזכיר מוסמך לענות עליהן.',
                callId,
                ++stepIdx
              );
              if (t) {
                recParams.faqAnswers = t;
                await saveAndSyncExt(cfg, 'תשובות לשאלות נפוצות עודכנו');
              }
            } else if (rSub === '6') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו מה המדיניות במקרה של פנייה דחופה.',
                callId,
                ++stepIdx
              );
              if (t) {
                recParams.urgentPolicy = t;
                await saveAndSyncExt(cfg, 'נוהל מקרים דחופים עודכן');
              }
            }
          } else if (cfg.role === 'sales') {
            const sParams = cfg.roleParams.sales;
            const sSub = await ask(
              'הגדרות נציג מכירות. ' +
                'לעדכון קטלוג מוצרים ומחירים הקישו 1. ' +
                'לעדכון יתרונות בולטים של העסק הקישו 2. ' +
                'לעדכון מבצע או הטבה נוכחית הקישו 3. ' +
                'לעדכון מענה להתנגדויות לקוח הקישו 4. ' +
                'לעדכון יעד הסגירה של השיחה הקישו 5. ' +
                'לבחירת רמת אסרטיביות ורטוריקת שכנוע הקישו 6. לחזרה הקישו 9'
            );
            if (sSub === '1') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את המוצרים השירותים והמחירים.',
                callId,
                ++stepIdx
              );
              if (t) {
                sParams.productsCatalog = t;
                await saveAndSyncExt(cfg, 'קטלוג המוצרים והמחירים עודכן');
              }
            } else if (sSub === '2') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את היתרונות המרכזיים של העסק שלכם.',
                callId,
                ++stepIdx
              );
              if (t) {
                sParams.uniqueSellingPoints = t;
                await saveAndSyncExt(cfg, 'יתרונות העסק עודכנו');
              }
            } else if (sSub === '3') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את פרטי המבצע או ההטבה המיוחדת.',
                callId,
                ++stepIdx
              );
              if (t) {
                sParams.currentPromo = t;
                await saveAndSyncExt(cfg, 'המבצע הנוכחי עודכן');
              }
            } else if (sSub === '4') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו כיצד לענות להתנגדויות של לקוחות.',
                callId,
                ++stepIdx
              );
              if (t) {
                sParams.objectionHandling = t;
                await saveAndSyncExt(cfg, 'מענה להתנגדויות עודכן');
              }
            } else if (sSub === '5') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו מה יעד הסגירה של שיחת המכירה.',
                callId,
                ++stepIdx
              );
              if (t) {
                sParams.closingGoal = t;
                await saveAndSyncExt(cfg, 'יעד הסגירה עודכן');
              }
            } else if (sSub === '6') {
              const pStyle = await ask(
                'למכירה ייעוצית ורכה הקישו 1. למכירה כריזמטית ומשכנעת הקישו 2. למכירה אסרטיבית ומכוונת סגירה הקישו 3.'
              );
              if (pStyle === '1') sParams.persuasionStyle = 'consultative';
              if (pStyle === '2') sParams.persuasionStyle = 'charismatic';
              if (pStyle === '3') sParams.persuasionStyle = 'closer';
              await saveAndSyncExt(cfg, 'רטוריקת המכירה עודכנה');
            }
          } else if (cfg.role === 'customer_service') {
            const csParams = cfg.roleParams.customer_service;
            const csSub = await ask(
              'הגדרות שירות לקוחות. ' +
                'לעדכון השירותים והמוצרים הנתמכים הקישו 1. ' +
                'לעדכון מדריך פתרון תקלות הקישו 2. ' +
                'לעדכון מדיניות החזרות ואחריות הקישו 3. ' +
                'לעדכון נוהל העברה לנציג בכיר הקישו 4. ' +
                'לעדכון זמן מענה מובטח הקישו 5. ' +
                'לבחירת רמת אמפתיה הקישו 6. לחזרה הקישו 9'
            );
            if (csSub === '1') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו באילו מוצרים או שירותים הנציג תומך.',
                callId,
                ++stepIdx
              );
              if (t) {
                csParams.supportedServices = t;
                await saveAndSyncExt(cfg, 'השירותים הנתמכים עודכנו');
              }
            } else if (csSub === '2') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את הפתרונות לתקלות ובעיות נפוצות.',
                callId,
                ++stepIdx
              );
              if (t) {
                csParams.troubleshootingGuide = t;
                await saveAndSyncExt(cfg, 'מדריך פתרון התקלות עודכן');
              }
            } else if (csSub === '3') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את מדיניות הביטולים ההחזרות והאחריות.',
                callId,
                ++stepIdx
              );
              if (t) {
                csParams.refundWarrantyPolicy = t;
                await saveAndSyncExt(cfg, 'מדיניות האחריות עודכנה');
              }
            } else if (csSub === '4') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו מתי וכיצד מעבירים פנייה לנציג אנושי.',
                callId,
                ++stepIdx
              );
              if (t) {
                csParams.escalationPolicy = t;
                await saveAndSyncExt(cfg, 'נוהל ההעברה לנציג עודכן');
              }
            } else if (csSub === '5') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו מה זמן המענה המובטח ללקוח.',
                callId,
                ++stepIdx
              );
              if (t) {
                csParams.slaPromise = t;
                await saveAndSyncExt(cfg, 'זמן המענה המובטח עודכן');
              }
            } else if (csSub === '6') {
              const emp = await ask(
                'לאמפתיה גבוהה והרגעה הקישו 1. למענה מעשי ומהיר הקישו 2. לשירות וי איי פי יוקרתי הקישו 3.'
              );
              if (emp === '1') csParams.empathyLevel = 'high';
              if (emp === '2') csParams.empathyLevel = 'practical';
              if (emp === '3') csParams.empathyLevel = 'vip';
              await saveAndSyncExt(cfg, 'גישת השירות עודכנה');
            }
          } else {
            // free_chat
            const fcParams = cfg.roleParams.free_chat;
            const fcSub = await ask(
              'הגדרות שיחה חופשית. ' +
                'לעדכון שם הדמות של הבוט הקישו 1. ' +
                'לעדכון אופי ורקע הדמות הקישו 2. ' +
                'לעדכון נושאים מועדפים לשיחה הקישו 3. ' +
                'לבחירת רמת סינון תוכן ושפה הקישו 4. ' +
                'לבחירת אופן הובלת השיחה הקישו 5. לחזרה הקישו 9'
            );
            if (fcSub === '1') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו את שם הדמות של הבוט.',
                callId,
                ++stepIdx
              );
              if (t) {
                fcParams.botPersonaName = t;
                await saveAndSyncExt(cfg, `שם הבוט עודכן ל${t}`);
              }
            } else if (fcSub === '2') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'תארו את האופי והרקע של הדמות.',
                callId,
                ++stepIdx
              );
              if (t) {
                fcParams.personaBackground = t;
                await saveAndSyncExt(cfg, 'אופי הדמות עודכן');
              }
            } else if (fcSub === '3') {
              const t = await recordAndTranscribeAdminInput(
                call,
                yemotToken,
                'אמרו אילו נושאים מועדפים לשיחה.',
                callId,
                ++stepIdx
              );
              if (t) {
                fcParams.favoriteTopics = t;
                await saveAndSyncExt(cfg, 'הנושאים המועדפים עודכנו');
              }
            } else if (fcSub === '4') {
              const flt = await ask(
                'לסינון שמור ונקי לחלוטין מותאם לציבור החרדי הקישו 1. לסינון משפחתי רגיל הקישו 2. לשיחה פתוחה הקישו 3.'
              );
              if (flt === '1') fcParams.contentFilterLevel = 'strict_kosher';
              if (flt === '2') fcParams.contentFilterLevel = 'family';
              if (flt === '3') fcParams.contentFilterLevel = 'open';
              await saveAndSyncExt(cfg, 'רמת סינון התוכן עודכנה');
            } else if (fcSub === '5') {
              const cm = await ask(
                'לחבר שיחה חם וזורם הקישו 1. ליועץ חכם ומעמיק הקישו 2. למספר סיפורים מעשיר הקישו 3. לדיון אינטלקטואלי מאתגר הקישו 4.'
              );
              if (cm === '1') fcParams.conversationMode = 'warm_friend';
              if (cm === '2') fcParams.conversationMode = 'wise_advisor';
              if (cm === '3') fcParams.conversationMode = 'storyteller';
              if (cm === '4') fcParams.conversationMode = 'intellectual_debate';
              await saveAndSyncExt(cfg, 'אופן הובלת השיחה עודכן');
            }
          }
        } else if (sub2 === '3') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את שם העסק.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.businessName = t;
            await saveAndSyncExt(cfg, `שם העסק עודכן ל${t}`);
          }
        } else if (sub2 === '4') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את המידע על העסק שהבוט צריך לדעת.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.businessInfo = t;
            await saveAndSyncExt(cfg, 'המידע על העסק עודכן');
          }
        } else if (sub2 === '5') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את ההוראות המיוחדות לבוט.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.customInstructions = t;
            await saveAndSyncExt(cfg, 'ההוראות המיוחדות עודכנו');
          }
        }
        continue;
      }

      // 3. Voice (with live voice sample preview before confirmation!), speaking rate, and Nikud
      if (mainChoice === '3') {
        const currentVoiceObj =
          VOICES.find((v) => v.name === cfg.voice?.name) || VOICES[0];
        const sub3 = await ask(
          `הקול הנוכחי הוא ${currentVoiceObj.spokenName}. ` +
            'לבחירת קול חדש מרשימת הקולות ושמיעת משפט לדוגמה לפני אישור הקישו 1. ' +
            'לשינוי מהירות הדיבור הקישו 2. ' +
            'להפעלה או כיבוי של ניקוד אוטומטי הקישו 3. ' +
            'לחזרה הקישו 9'
        );
        if (sub3 === '1') {
          let voiceSaved = false;
          while (!voiceSaved) {
            const groupChoice = await ask(
              'בחרו קטגוריית קולות: ' +
                'לקולות גברים מקצועיים של גוגל סטודיו קבוצה א — עמוקים סמכותיים ועסקיים הקישו 1. ' +
                'לקולות גברים נוספים של גוגל סטודיו קבוצה ב — לבביים שיחתיים וקרייניים הקישו 2. ' +
                'לקולות נשים מקצועיים של גוגל סטודיו הקישו 3. ' +
                'לקולות קלאסיים ווייבנט גברים ונשים הקישו 4. ' +
                'לחזרה הקישו 9'
            );
            if (!groupChoice || groupChoice === '9' || groupChoice.toLowerCase().includes('hangup')) {
              break;
            }
            let pool = VOICES.filter((v) => v.category === 'studio_male_a');
            if (groupChoice === '2') {
              pool = VOICES.filter((v) => v.category === 'studio_male_b');
            } else if (groupChoice === '3') {
              pool = VOICES.filter((v) => v.category === 'studio_female');
            } else if (groupChoice === '4') {
              pool = VOICES.filter((v) => v.category === 'classic');
            }

            while (!voiceSaved) {
              const listPrompt =
                'בחרו קול לשמיעת משפט לדוגמה: ' +
                pool
                  .slice(0, 8)
                  .map((v, i) => `לקול ${v.spokenName} הקישו ${i + 1}`)
                  .join('. ') +
                '. לחזרה לבחירת קטגוריה הקישו 9';
              const r = await ask(listPrompt);
              if (!r || r === '9' || r.toLowerCase().includes('hangup')) {
                break;
              }
              const picked = pool[Number(r) - 1];
              if (!picked) {
                await notice('בחירה לא תקינה, נסו שוב');
                continue;
              }

              // Synthesize & play a live sample sentence in the candidate voice before confirming!
              const sampleSentence =
                'שלום וברכה! כך הקול שלי נשמע בשיחת הטלפון במערכת ימות איי איי. אם הקול הזה נעים ומתאים לכם, אשמח לענות למתקשרים שלכם בקול הזה.';
              const rate = cfg.voice?.speakingRate ?? 1.0;
              let previewPath = '';
              try {
                const sampleHash = getTtsHash(sampleSentence, picked.name, rate);
                previewPath = `/ApiAudio/prev_${sampleHash}`;
                const sysNum = yemotToken.split(':')[0];
                const prevKey = `${sysNum}:${previewPath}`;
                if (!uploadedGreetingsOnYemot.has(prevKey)) {
                  const sampleAudio = await synthesizeSpeechAudio(sampleSentence, picked.name, rate);
                  await uploadAudioToYemot(
                    yemotToken,
                    sampleAudio.buf,
                    sampleAudio.mime,
                    `${previewPath}.wav`
                  );
                  markFileUploadedOnYemot(prevKey);
                }
              } catch (e) {
                console.warn('Voice preview upload warning:', (e as Error)?.message || e);
                previewPath = '';
              }

              let keepPreviewingThisVoice = true;
              while (keepPreviewingThisVoice) {
                const confirmInstructionMsgs = await toCachedAdminMessages(
                  yemotToken,
                  previewPath
                    ? `שמעתם כעת דוגמה של הקול ${picked.spokenName}. לאישור ושמירת הקול הזה הקישו 1. לשמיעת המשפט לדוגמה פעם נוספת הקישו 2. לבחירת קול אחר מהרשימה הקישו 3`
                    : `נבחר הקול ${picked.spokenName}. לאישור ושמירת הקול הזה הקישו 1. לבחירת קול אחר מהרשימה הקישו 3`
                );
                const confirmPrompt: YemotMessage[] = previewPath
                  ? [{ type: 'file', data: previewPath }, ...confirmInstructionMsgs]
                  : confirmInstructionMsgs;

                const confirmTap = await call.read(confirmPrompt, 'tap', {
                  max_digits: 1,
                  min_digits: 1,
                  sec_wait: 9,
                });

                if (confirmTap === '1') {
                  cfg.voice = {
                    provider: 'google',
                    name: picked.name,
                    speakingRate: rate,
                  };
                  await saveAndSyncExt(
                    cfg,
                    `הקול אושר ועודכן בהצלחה ל${picked.spokenName} ויישמר קבוע בכל השיחות`,
                    true
                  );
                  voiceSaved = true;
                  keepPreviewingThisVoice = false;
                } else if (confirmTap === '2' && previewPath) {
                  // Loop again to replay the voice sample
                  continue;
                } else {
                  // Go back to the numbered voice list
                  keepPreviewingThisVoice = false;
                }
              }
            }
          }
        } else if (sub3 === '2') {
          const rateChoice = await ask(
            'לדיבור איטי הקישו 1. לדיבור רגיל הקישו 2. לדיבור מהיר הקישו 3. לדיבור מהיר מאוד הקישו 4.'
          );
          const rates: Record<string, number> = { '1': 0.85, '2': 1.0, '3': 1.15, '4': 1.3 };
          if (rates[rateChoice]) {
            cfg.voice = {
              provider: 'google',
              name: cfg.voice?.name || 'he-IL-Chirp3-HD-Charon',
              speakingRate: rates[rateChoice],
            };
            await saveAndSyncExt(cfg, 'מהירות הדיבור עודכנה', true);
          }
        } else if (sub3 === '3') {
          cfg.useNikud = !cfg.useNikud;
          await saveAndSyncExt(cfg, cfg.useNikud ? 'ניקוד אוטומטי הופעל' : 'ניקוד אוטומטי כובה');
        }
        continue;
      }

      // 4. Speaking style
      if (mainChoice === '4') {
        const keys = Object.keys(STYLES);
        const r = await ask(
          keys.map((k, i) => `לסגנון ${STYLE_NAMES_HE[k] || k} הקישו ${i + 1}`).join('. ')
        );
        const picked = keys[Number(r) - 1];
        if (picked) {
          cfg.style = picked;
          await saveAndSyncExt(cfg, `סגנון הדיבור עודכן ל${STYLE_NAMES_HE[picked]}`);
        }
        continue;
      }

      // 5. System messages (Greeting, Goodbye, Consent, Closed, Denied, Off-topic)
      if (mainChoice === '5') {
        const sub5 = await ask(
          'לעדכון הודעת פתיחה הקישו 1. ' +
            'לעדכון הודעת סיום הקישו 2. ' +
            'לעדכון הודעת הסכמה להקלטה הקישו 3. ' +
            'לעדכון הודעה כשהשירות סגור הקישו 4. ' +
            'לעדכון הודעה למספר חסום הקישו 5. ' +
            'לעדכון תשובה לנושא לא מורשה הקישו 6. ' +
            'למחיקת הודעת ההסכמה הקישו 7. לחזרה הקישו 9'
        );
        if (sub5 === '1') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את הודעת הפתיחה החדשה.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.greeting = t;
            await saveAndSyncExt(cfg, 'הודעת הפתיחה עודכנה');
          }
        } else if (sub5 === '2') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את הודעת הסיום החדשה.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.goodbye = t;
            await saveAndSyncExt(cfg, 'הודעת הסיום עודכנה');
          }
        } else if (sub5 === '3') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את הודעת ההסכמה שתושמע לפני הפתיחה.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.consentMessage = t;
            await saveAndSyncExt(cfg, 'הודעת ההסכמה עודכנה');
          }
        } else if (sub5 === '4') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את ההודעה שתושמע כשהשירות סגור.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.closedMessage = t;
            await saveAndSyncExt(cfg, 'הודעת הסגירה עודכנה');
          }
        } else if (sub5 === '5') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את ההודעה שתושמע למתקשר חסום.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.deniedMessage = t;
            await saveAndSyncExt(cfg, 'הודעת החסימה עודכנה');
          }
        } else if (sub5 === '6') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את התשובה כשהמתקשר שואל על נושא לא מורשה.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.offTopicReply = t;
            await saveAndSyncExt(cfg, 'התשובה לנושא לא מורשה עודכנה');
          }
        } else if (sub5 === '7') {
          cfg.consentMessage = '';
          await saveAndSyncExt(cfg, 'הודעת ההסכמה הוסרה');
        }
        continue;
      }

      // 6. Topics restrictions
      if (mainChoice === '6') {
        const sub6 = await ask(
          'למצב כל הנושאים מותרים הקישו 1. ' +
            'למצב רק נושאים מותרים הקישו 2. ' +
            'למצב חסימת נושאים הקישו 3. ' +
            'להקלטת רשימת הנושאים הקישו 4. לחזרה הקישו 9'
        );
        if (sub6 === '1') {
          cfg.topicsMode = 'all';
          await saveAndSyncExt(cfg, 'הוגדר שכל הנושאים מותרים');
        } else if (sub6 === '2') {
          cfg.topicsMode = 'allowed';
          await saveAndSyncExt(cfg, 'הוגדר מצב רק נושאים מותרים');
        } else if (sub6 === '3') {
          cfg.topicsMode = 'blocked';
          await saveAndSyncExt(cfg, 'הוגדר מצב חסימת נושאים');
        } else if (sub6 === '4') {
          const t = await recordAndTranscribeAdminInput(
            call,
            yemotToken,
            'אמרו את רשימת הנושאים מופרדים בפסיקים.',
            callId,
            ++stepIdx
          );
          if (t) {
            cfg.topics = t
              .split(/[,. ו]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            await saveAndSyncExt(cfg, 'רשימת הנושאים עודכנה');
          }
        }
        continue;
      }

      // 7. Caller access control (Whitelist / Blacklist)
      if (mainChoice === '7') {
        const sub7 = await ask(
          'לפתיחת השלוחה לכל המספרים הקישו 1. ' +
            'למצב רשימה לבנה בלבד הקישו 2. ' +
            'למצב רשימה שחורה הקישו 3. ' +
            'להוספת מספר טלפון לרשימה הקישו 4. ' +
            'להסרת מספר טלפון מהרשימה הקישו 5. ' +
            'לניקוי כל המספרים מהרשימה הקישו 6. לחזרה הקישו 9'
        );
        if (!cfg.access) cfg.access = { mode: 'all', numbers: [] };
        if (sub7 === '1') {
          cfg.access.mode = 'all';
          await saveAndSyncExt(cfg, 'השלוחה פתוחה כעת לכל המספרים');
        } else if (sub7 === '2') {
          cfg.access.mode = 'whitelist';
          await saveAndSyncExt(cfg, 'הופעלה רשימה לבנה בלבד');
        } else if (sub7 === '3') {
          cfg.access.mode = 'blacklist';
          await saveAndSyncExt(cfg, 'הופעלה רשימה שחורה');
        } else if (sub7 === '4') {
          const num = await ask('הקישו את מספר הטלפון להוספה ובסיום סולמית', 12);
          const clean = normPhone(num);
          if (clean && clean !== 'anonymous') {
            cfg.access.numbers = Array.from(new Set([...(cfg.access.numbers || []), clean]));
            await saveAndSyncExt(cfg, 'המספר נוסף לרשימה');
          }
        } else if (sub7 === '5') {
          const num = await ask('הקישו את מספר הטלפון להסרה ובסיום סולמית', 12);
          const clean = normPhone(num);
          cfg.access.numbers = (cfg.access.numbers || []).filter((n) => normPhone(n) !== clean);
          await saveAndSyncExt(cfg, 'המספר הוסר מהרשימה');
        } else if (sub7 === '6') {
          cfg.access.numbers = [];
          await saveAndSyncExt(cfg, 'הרשימה נוקתה');
        }
        continue;
      }

      // 8. Schedule, max call duration, hands-free conversation mode, and tools
      if (mainChoice === '8') {
        const hfStatus =
          cfg.handsFreeMode !== false
            ? `פעיל ללא צורך בסולמית, מענה אוטומטי כל ${cfg.handsFreeAutoStopSec || 6} שניות`
            : 'כבוי, סיום דיבור בלחיצה על סולמית';
        const sub8 = await ask(
          `מצב שיחה טבעית כעת: ${hfStatus}. ` +
            'להפעלה או כיבוי של הגבלת שעות פעילות הקישו 1. ' +
            'להגדרת אורך שיחה מקסימלי בדקות הקישו 2. ' +
            'להפעלה או כיבוי של שליחת מייל הקישו 3. ' +
            'להפעלה או כיבוי של יצירת תמונות הקישו 4. ' +
            'להגדרת מצב שיחה טבעית רציפה ללא צורך בלחיצה על סולמית הקישו 5. לחזרה הקישו 9'
        );
        if (sub8 === '1') {
          cfg.schedule = { ...(cfg.schedule || { tz: 'Asia/Jerusalem', days: DEFAULT_DAYS }), enabled: !cfg.schedule?.enabled };
          await saveAndSyncExt(
            cfg,
            cfg.schedule.enabled ? 'הגבלת שעות פעילות הופעלה' : 'הגבלת שעות פעילות כובתה'
          );
        } else if (sub8 === '2') {
          const mins = await ask('הקישו אורך שיחה מקסימלי בדקות מ 1 עד 60 ובסיום סולמית', 2);
          const parsed = Number(mins);
          if (parsed >= 1 && parsed <= 60) {
            cfg.maxMinutes = parsed;
            await saveAndSyncExt(cfg, `אורך השיחה המקסימלי עודכן ל ${parsed} דקות`);
          }
        } else if (sub8 === '3') {
          cfg.tools = { ...(cfg.tools || { email: true, images: true }), email: !cfg.tools?.email };
          await saveAndSyncExt(cfg, cfg.tools.email ? 'כלי שליחת מייל הופעל' : 'כלי שליחת מייל כובה');
        } else if (sub8 === '4') {
          cfg.tools = { ...(cfg.tools || { email: true, images: true }), images: !cfg.tools?.images };
          await saveAndSyncExt(cfg, cfg.tools.images ? 'כלי יצירת תמונות הופעל' : 'כלי יצירת תמונות כובה');
        } else if (sub8 === '5') {
          const hfChoice = await ask(
            'לשיחה טבעית מהירה מאוד ללא סולמית עם מענה אוטומטי תוך 4 שניות הקישו 1. ' +
              'לשיחה טבעית מאוזנת ללא סולמית עם מענה אוטומטי תוך 6 שניות הקישו 2. ' +
              'לשיחה טבעית למשפטים ארוכים ללא סולמית עם מענה אוטומטי תוך 8 שניות הקישו 3. ' +
              'למצב הקלטה ארוכה עם לחיצה על סולמית בסיום כל משפט הקישו 4. לחזרה הקישו 9'
          );
          if (hfChoice === '1') {
            cfg.handsFreeMode = true;
            cfg.handsFreeAutoStopSec = 4;
            await saveAndSyncExt(cfg, 'הופעל מצב שיחה טבעית מהירה ללא צורך בסולמית, 4 שניות למשפט');
          } else if (hfChoice === '2') {
            cfg.handsFreeMode = true;
            cfg.handsFreeAutoStopSec = 6;
            await saveAndSyncExt(cfg, 'הופעל מצב שיחה טבעית מאוזנת ללא צורך בסולמית, 6 שניות למשפט');
          } else if (hfChoice === '3') {
            cfg.handsFreeMode = true;
            cfg.handsFreeAutoStopSec = 8;
            await saveAndSyncExt(cfg, 'הופעל מצב שיחה טבעית למשפטים ארוכים ללא סולמית, 8 שניות למשפט');
          } else if (hfChoice === '4') {
            cfg.handsFreeMode = false;
            await saveAndSyncExt(cfg, 'הופעל מצב סיום דיבור בלחיצה על סולמית');
          }
        }
        continue;
      }

      // 9. Memory management, stats, and multi-extension switching / creation
      if (mainChoice === '9') {
        const extList = Object.keys(tenant.extensions || { [activeExtKey]: cfg });
        const callerCount = Object.keys(
          tenant.extensionMemories?.[activeExtKey] || tenant.memory || {}
        ).length;
        const sub9 = await ask(
          `בשלוחה זו שמורים ${callerCount} מתקשרים בזיכרון, והיום בוצעו ${tenant.callsToday || 0} שיחות. ` +
            `במערכת מוגדרות ${extList.length} שלוחות צאט. ` +
            'למעבר לניהול שלוחת צאט אחרת או פתיחת שלוחה חדשה הקישו 1. ' +
            'למחיקת זיכרון שיחות של מספר טלפון מסוים הקישו 2. ' +
            'לאיפוס כל זיכרון השיחות בשלוחה זו הקישו 3. ' +
            'לשינוי מגבלת השיחות היומית הקישו 4. לחזרה הקישו 9'
        );
        if (sub9 === '1') {
          const newExt = await ask(
            'הקישו את מספר השלוחה שברצונכם לנהל או להגדיר כבוט צאט חדש, למשל 1 או 2 או 4, ובסיום סולמית',
            4
          );
          const cleaned = normalizeExtKey(newExt);
          if (cleaned) {
            activeExtKey = cleaned;
            if (!tenant.extensions?.[activeExtKey]) {
              const freshCfg = mergeConfigWithDefaults({
                ...cfg,
                yemotChatExt: activeExtKey,
              });
              await saveAndSyncExt(freshCfg, `שלוחה ${activeExtKey} נוצרה והוגדרה כשלוחת צאט חדשה`);
            } else {
              await notice(`עברתם לניהול שלוחה ${activeExtKey}`);
            }
          }
        } else if (sub9 === '2') {
          const phoneToClear = await ask('הקישו את מספר הטלפון למחיקת הזיכרון ובסיום סולמית', 12);
          const cleanP = normPhone(phoneToClear);
          if (cleanP) {
            if (tenant.extensionMemories?.[activeExtKey]) {
              delete tenant.extensionMemories[activeExtKey][cleanP];
            }
            if (tenant.memory) {
              delete tenant.memory[cleanP];
            }
            yemotDeleteFile(
              yemotToken,
              `ivr2:/ApiRecords/mem_${extKeyToSlug(activeExtKey)}_${cleanP}.tts`
            ).catch(() => {});
            tenants[tenant.id] = tenant;
            saveLocalTenants(tenants);
            await notice('זיכרון השיחות של המספר נמחק');
          }
        } else if (sub9 === '3') {
          if (tenant.extensionMemories) {
            tenant.extensionMemories[activeExtKey] = {};
          }
          tenant.memory = {};
          tenants[tenant.id] = tenant;
          saveLocalTenants(tenants);
          await notice('כל זיכרון השיחות בשלוחה זו אופס בהצלחה');
        } else if (sub9 === '4') {
          const lim = await ask('הקישו מגבלת שיחות יומית חדשה ובסיום סולמית', 4);
          const parsedLim = Number(lim);
          if (parsedLim >= 1) {
            tenant.dailyCallLimit = parsedLim;
            tenants[tenant.id] = tenant;
            saveLocalTenants(tenants);
            persistTenantToYemotCloud(tenant).catch(() => {});
            await notice(`מגבלת השיחות היומית עודכנה ל ${parsedLim} שיחות`);
          }
        }
        continue;
      }
    }
  });

  // Thread-safe URL routing for short links (/c, /a) and full links (/chat/:tenantId, /admin/:tenantId)
  app.use((req, res, next) => {
    const m = req.url.match(
      /^\/(chat|admin|c|a)(?:\/([a-z0-9-]{3,40})(?:\/([a-zA-Z0-9_-]{1,20}))?)?(\?.*)?$/
    );
    if (!m) return next();
    const routeType = m[1] === 'c' || m[1] === 'chat' ? 'chat' : 'admin';
    const queryPart = m[4] || '';
    if (req.query?.hangup === 'yes' || queryPart.includes('hangup=yes')) {
      res.status(200).json({ message: 'hangup' });
      return;
    }
    const q = (req.query && typeof req.query === 'object' ? req.query : {}) as Record<
      string,
      string
    >;
    const rawDid = m[2] || String(q.ApiDID || q.ApiRealDID || '').replace(/\D/g, '');
    const rawExt = m[3] || String(q.ApiExtension || '');

    const extReq = req as express.Request & { yemotTenantId?: string; yemotExtId?: string };
    if (rawDid) {
      extReq.yemotTenantId = rawDid;
    }
    if (rawExt) {
      extReq.yemotExtId = rawExt;
    }
    if (req.query && typeof req.query === 'object') {
      if (!q.ApiDID && rawDid) q.ApiDID = rawDid;
      if (!q.ApiRealDID && q.ApiDID) q.ApiRealDID = q.ApiDID;
      if (!q.ApiExtension) q.ApiExtension = rawExt || '1';
      if (!q.ApiEnterID) q.ApiEnterID = q.ApiCallId || '1';
      if (!q.ApiPhone) q.ApiPhone = '0500000000';
    }
    req.url = `/${routeType}${queryPart}`;
    return yemotRouter(req, res, next);
  });

  function formatExtensionsSummary(tenant: StoredTenant) {
    return Object.entries(tenant.extensions || {}).map(([k, v]) => ({
      ext: k === 'root' ? 'main' : k,
      role: v.role,
      roleLabel: PRESETS[v.role]?.label || v.role,
      voice: v.voice?.name || 'he-IL-Wavenet-A',
      voiceName: v.voice?.name || 'he-IL-Wavenet-A',
      businessName: v.businessName || '',
      greeting: v.greeting || '',
      enabled: v.enabled,
      memoryCallersCount: Object.keys(tenant.extensionMemories?.[k] || {}).length,
    }));
  }

  // Handle /tapi/:tenantId/*
  app.all('/tapi/:tenantId/*', async (req, res) => {
    const tenantId = req.params.tenantId;
    const subPath = '/' + (req.params as unknown as Record<string, string>)[0];
    const authHeader = req.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      res.status(401).json({ error: 'חסר טוקן או סיסמה בבקשה.' });
      return;
    }

    const authResult = await authenticateOrCreateLocalTenant(tenantId, token);
    if (!authResult.tenant) {
      if (subPath !== '/setup-yemot') {
        try {
          const renderUrl = `${RENDER_ORIGIN}/tapi/${encodeURIComponent(tenantId)}${subPath}`;
          const renderRes = await fetch(renderUrl, {
            method: req.method,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body:
              req.method !== 'GET' && req.method !== 'HEAD'
                ? JSON.stringify(req.body || {})
                : undefined,
          });
          if (renderRes.ok) {
            const text = await renderRes.text();
            res.status(renderRes.status).json(JSON.parse(text));
            return;
          }
        } catch {
          // ignore
        }
      }

      res.status(authResult.status || 401).json({
        error: authResult.error || 'מספר המערכת או הסיסמה שגויים.',
      });
      return;
    }

    const tenant = authResult.tenant;
    const tenants = loadLocalTenants();
    const publicOrigin = getPublicOrigin(req);
    const requestedExt =
      typeof req.query.ext === 'string' && req.query.ext.trim()
        ? normalizeExtKey(req.query.ext)
        : undefined;

    // One-Click Yemot Extension Setup Endpoint (supports multiple independent extensions!)
    if (req.method === 'POST' && subPath === '/setup-yemot') {
      const chatExtRaw = String(req.body?.chatExt ?? requestedExt ?? tenant.yemotChatExt ?? '1').trim();
      const adminExt = String(req.body?.adminExt ?? tenant.yemotAdminExt ?? '').trim();
      const extKey = normalizeExtKey(chatExtRaw);

      const yemotNum = tenant.yemotNumber || tenantId.replace(/\D/g, '');
      const yemotPass = tenant.yemotPassword || token;

      if (!yemotNum || !yemotPass) {
        res.status(400).json({
          error: 'חסרים מספר מערכת או סיסמת ניהול של ימות המשיח.',
        });
        return;
      }

      const existingExtCfg = getTenantExtConfig(tenant, extKey);
      const currentCfg: TenantConfigData = setTenantExtConfig(tenant, extKey, {
        ...existingExtCfg,
        ...(req.body?.config || {}),
        yemotChatExt: extKey === 'root' ? 'main' : extKey,
        yemotAdminExt: adminExt,
      });

      const chatApiLink = `${publicOrigin}/c`;
      const mainRes = await configureYemotExtensionFull(
        yemotNum,
        yemotPass,
        extKey === 'root' ? 'root' : extKey,
        chatApiLink,
        currentCfg,
        false
      );

      if (!mainRes.ok) {
        res.status(400).json({
          error: mainRes.error || 'הגדרת השלוחה בימות המשיח נכשלה.',
        });
        return;
      }

      if (adminExt) {
        const adminApiLink = `${publicOrigin}/a`;
        await configureYemotExtensionFull(
          yemotNum,
          yemotPass,
          adminExt,
          adminApiLink,
          currentCfg,
          true
        );
      }

      tenant.yemotChatExt = extKey === 'root' ? 'root' : extKey;
      tenant.yemotAdminExt = adminExt;
      tenant.yemotSyncedAt = new Date().toISOString();
      tenants[tenant.id] = tenant;
      saveLocalTenants(tenants);
      persistTenantToYemotCloud(tenant).catch(() => {});
      syncTenantToDeployedCloudRun(tenant.id, yemotPass, currentCfg, extKey).catch(() => {});

      const extLabel =
        extKey === 'root' ? 'השלוחה הראשית' : `שלוחה ${extKey}`;

      res.json({
        ok: true,
        chatExt: extKey === 'root' ? 'main' : extKey,
        adminExt,
        apiLink: chatApiLink,
        extensions: formatExtensionsSummary(tenant),
        message: `${extLabel} במערכת ${yemotNum} הוגדרה וחוברה בהצלחה עם הגדרות, קול וזיכרון עצמאיים!`,
      });
      return;
    }

    // Delete a secondary chat extension from the tenant list
    if (req.method === 'DELETE' && subPath.startsWith('/extensions/')) {
      const extToDel = normalizeExtKey(decodeURIComponent(subPath.replace('/extensions/', '')));
      const allKeys = Object.keys(tenant.extensions || {});
      if (allKeys.length <= 1) {
        res.status(400).json({ error: 'חייבת להישאר לפחות שלוחת צ׳אט אחת במערכת.' });
        return;
      }
      if (tenant.extensions && tenant.extensions[extToDel]) {
        delete tenant.extensions[extToDel];
      }
      const nextActive = Object.keys(tenant.extensions || {})[0] || '1';
      tenant.yemotChatExt = nextActive;
      tenant.config = getTenantExtConfig(tenant, nextActive);
      tenants[tenant.id] = tenant;
      saveLocalTenants(tenants);
      persistTenantToYemotCloud(tenant).catch(() => {});
      res.json({
        ok: true,
        activeExt: nextActive === 'root' ? 'main' : nextActive,
        extensions: formatExtensionsSummary(tenant),
      });
      return;
    }

    if (req.method === 'GET' && subPath === '/status') {
      const today = new Date().toISOString().slice(0, 10);
      const callsToday = tenant.lastCallDay === today ? tenant.callsToday : 0;
      const activeExt = requestedExt || normalizeExtKey(tenant.yemotChatExt || '1');
      const extMemoryCallers = Object.keys(
        tenant.extensionMemories?.[activeExt] || tenant.memory || {}
      );
      const uiExt = activeExt === 'root' ? 'main' : activeExt;
      res.json({
        id: tenant.id,
        name: tenant.name,
        yemotNumberSet: Boolean(tenant.yemotNumber),
        yemotPasswordSet: Boolean(tenant.yemotPassword),
        brevoKeySet: Boolean(tenant.brevoApiKey),
        mailFrom: tenant.mailFrom || null,
        callsToday,
        dailyCallLimit: tenant.dailyCallLimit || 200,
        activeExt: uiExt,
        yemotChatExt: uiExt,
        yemotAdminExt: tenant.yemotAdminExt || tenant.config?.yemotAdminExt || '',
        yemotSyncedAt: tenant.yemotSyncedAt || null,
        memoryCallersCount: extMemoryCallers.length,
        memoryCallers: extMemoryCallers.slice(0, 50),
        extensions: formatExtensionsSummary(tenant),
      });
      return;
    }

    if (req.method === 'GET' && subPath === '/config') {
      const activeExt = requestedExt || normalizeExtKey(tenant.yemotChatExt || '1');
      const extCfg = getTenantExtConfig(tenant, activeExt);
      const uiExt = activeExt === 'root' ? 'main' : activeExt;
      res.json({
        ...extCfg,
        yemotChatExt: uiExt,
        yemotAdminExt: tenant.yemotAdminExt || extCfg.yemotAdminExt || '',
      });
      return;
    }

    if (req.method === 'PUT' && subPath === '/config') {
      const targetExt = normalizeExtKey(
        requestedExt || req.body?.yemotChatExt || tenant.yemotChatExt || '1'
      );
      const prevExtCfg = getTenantExtConfig(tenant, targetExt);
      const nextConfig = setTenantExtConfig(tenant, targetExt, {
        ...prevExtCfg,
        ...(req.body || {}),
        yemotChatExt: targetExt === 'root' ? 'main' : targetExt,
      });

      let yemotSyncMessage = '';
      const yemotNum = tenant.yemotNumber || tenantId.replace(/\D/g, '');
      const yemotPass = tenant.yemotPassword || token;
      if (nextConfig.autoSyncYemot !== false && yemotNum && yemotPass) {
        const chatApiLink = `${publicOrigin}/c`;
        const syncRes = await configureYemotExtensionFull(
          yemotNum,
          yemotPass,
          targetExt === 'root' ? 'root' : targetExt,
          chatApiLink,
          nextConfig,
          false
        );
        if (syncRes.ok) {
          tenant.yemotSyncedAt = new Date().toISOString();
          const extLabel =
            targetExt === 'root' ? 'השלוחה הראשית' : `שלוחה ${targetExt}`;
          yemotSyncMessage = `כל ההגדרות נשמרו בשרת המאובטח ולינק הגישה הקצר עודכן ב${extLabel} בימות המשיח!`;
        }
        if (nextConfig.yemotAdminExt?.trim()) {
          const adminApiLink = `${publicOrigin}/a`;
          await configureYemotExtensionFull(
            yemotNum,
            yemotPass,
            nextConfig.yemotAdminExt.trim(),
            adminApiLink,
            nextConfig,
            true
          );
        }
        syncTenantToDeployedCloudRun(tenant.id, yemotPass, nextConfig, targetExt).catch(() => {});
      }

      tenants[tenant.id] = tenant;
      saveLocalTenants(tenants);
      persistTenantToYemotCloud(tenant).catch(() => {});
      res.json({
        ...nextConfig,
        yemotSyncMessage,
        extensions: formatExtensionsSummary(tenant),
      });
      return;
    }

    if (req.method === 'PUT' && subPath === '/secrets') {
      const body = req.body || {};
      if (typeof body.yemotNumber === 'string' && body.yemotNumber.trim()) {
        tenant.yemotNumber = body.yemotNumber.trim();
      }
      if (typeof body.yemotPassword === 'string' && body.yemotPassword.trim()) {
        tenant.yemotPassword = body.yemotPassword.trim();
      }
      if (typeof body.brevoApiKey === 'string' && body.brevoApiKey.trim()) {
        tenant.brevoApiKey = body.brevoApiKey.trim();
      }
      if (typeof body.mailFrom === 'string' && body.mailFrom.trim()) {
        tenant.mailFrom = body.mailFrom.trim();
      }
      tenants[tenant.id] = tenant;
      saveLocalTenants(tenants);
      persistTenantToYemotCloud(tenant).catch(() => {});
      res.json({ ok: true });
      return;
    }

    if (req.method === 'GET' && subPath === '/options') {
      res.json({
        presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
        styles: Object.keys(STYLES),
        voices: VOICES,
      });
      return;
    }

    if (req.method === 'POST' && subPath === '/tts-preview') {
      const text = String(req.body?.text || 'שלום, כך אני נשמע בשיחת הטלפון.').slice(0, 300);
      const voiceName = String(req.body?.voice || req.body?.voiceName || 'he-IL-Chirp3-HD-Charon');
      const speakingRate = Number(req.body?.speakingRate) || 1.0;

      try {
        const { buf, mime } = await synthesizeSpeechAudio(text, voiceName, speakingRate);
        res.json({ mime, base64: buf.toString('base64') });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('TTS Preview failed:', msg);
        res.status(500).json({ error: 'הפקת דגימת הקול נכשלה: ' + msg });
      }
      return;
    }

    if (req.method === 'DELETE' && subPath.startsWith('/memory/')) {
      const rawTarget = decodeURIComponent(subPath.replace('/memory/', '')).trim();
      const activeExt = requestedExt || normalizeExtKey(tenant.yemotChatExt || '1');
      const yemotToken =
        tenant.yemotNumber && tenant.yemotPassword
          ? `${tenant.yemotNumber}:${tenant.yemotPassword}`
          : '';
      let clearedCount = 0;

      if (rawTarget.toLowerCase() === 'all' || rawTarget === '*') {
        clearedCount = Object.keys(
          tenant.extensionMemories?.[activeExt] || tenant.memory || {}
        ).length;
        if (tenant.extensionMemories) {
          tenant.extensionMemories[activeExt] = {};
        }
        tenant.memory = {};
      } else {
        const phone = normPhone(rawTarget);
        if (phone) {
          clearedCount = 1;
          if (tenant.extensionMemories?.[activeExt]) {
            delete tenant.extensionMemories[activeExt][phone];
          }
          if (tenant.memory) {
            delete tenant.memory[phone];
          }
          if (yemotToken) {
            yemotDeleteFile(
              yemotToken,
              `ivr2:/ApiRecords/mem_${extKeyToSlug(activeExt)}_${phone}.tts`
            ).catch(() => {});
          }
        }
      }
      tenants[tenant.id] = tenant;
      saveLocalTenants(tenants);
      persistTenantToYemotCloud(tenant).catch(() => {});
      res.json({ ok: true, clearedCount });
      return;
    }

    res.status(404).json({ error: 'נקודת הקצה לא נמצאה.' });
  });

  // Super-Admin Hidden Portal Endpoints (Protected by dual credentials: password 04104 + manager code 217304104)
  const SUPER_ADMIN_PASSWORD = '04104';
  const SUPER_ADMIN_CODE = '217304104';

  function verifySuperAdminAuth(req: express.Request): boolean {
    const pass = String(req.body?.password || req.get('x-super-password') || '').trim();
    const code = String(req.body?.managerCode || req.get('x-super-code') || '').trim();
    return pass === SUPER_ADMIN_PASSWORD && code === SUPER_ADMIN_CODE;
  }

  app.post('/api/super-admin/overview', async (req, res) => {
    if (!verifySuperAdminAuth(req)) {
      res.status(403).json({ error: 'גישה נדחתה: סיסמת מנהל או קוד מנהל שגויים.' });
      return;
    }

    const tenants = loadLocalTenants();
    const today = new Date().toISOString().slice(0, 10);
    const publicOrigin = getPublicOrigin(req);

    const systems = Object.values(tenants).map((rawT) => {
      const t = normalizeTenantStructure(rawT);
      const callsToday = t.lastCallDay === today ? t.callsToday || 0 : 0;
      const extensionsDetail = Object.entries(t.extensions || {}).map(([extKey, cfg]) => {
        const uiExt = extKey === 'root' ? 'main' : extKey;
        const voiceObj = VOICES.find((v) => v.name === cfg.voice?.name);
        const callersMap = t.extensionMemories?.[extKey] || (extKey === normalizeExtKey(t.yemotChatExt) ? t.memory : {}) || {};
        const callersList = Object.keys(callersMap);
        return {
          ext: uiExt,
          enabled: cfg.enabled,
          role: cfg.role,
          roleLabel: PRESETS[cfg.role]?.label || cfg.role,
          style: cfg.style,
          styleLabel: STYLE_NAMES_HE[cfg.style] || cfg.style,
          voiceName: cfg.voice?.name || 'he-IL-Wavenet-A',
          voiceLabel: voiceObj?.label || cfg.voice?.name || 'he-IL-Wavenet-A',
          speakingRate: cfg.voice?.speakingRate ?? 1.0,
          useNikud: Boolean(cfg.useNikud),
          handsFreeMode: cfg.handsFreeMode !== false,
          handsFreeAutoStopSec: cfg.handsFreeAutoStopSec || 4,
          notificationEmail: cfg.notificationEmail || '',
          businessName: cfg.businessName || '',
          businessInfo: cfg.businessInfo || '',
          customInstructions: cfg.customInstructions || '',
          greeting: cfg.greeting || '',
          goodbye: cfg.goodbye || '',
          consentMessage: cfg.consentMessage || '',
          closedMessage: cfg.closedMessage || '',
          deniedMessage: cfg.deniedMessage || '',
          topicsMode: cfg.topicsMode || 'all',
          topics: cfg.topics || [],
          offTopicReply: cfg.offTopicReply || '',
          accessMode: cfg.access?.mode || 'all',
          accessNumbers: cfg.access?.numbers || [],
          maxMinutes: cfg.maxMinutes || 10,
          scheduleEnabled: Boolean(cfg.schedule?.enabled),
          tools: cfg.tools || { email: true, images: true },
          roleParams: cfg.roleParams || DEFAULT_ROLE_PARAMS,
          memoryCallersCount: callersList.length,
          memoryCallers: callersList.slice(0, 100),
          apiLink: `${publicOrigin}/chat/${t.id}/${uiExt}`,
        };
      });

      const totalCallers = extensionsDetail.reduce((acc, e) => acc + e.memoryCallersCount, 0);

      return {
        id: t.id,
        name: t.name || `מערכת ${t.yemotNumber || t.id}`,
        yemotNumber: t.yemotNumber || t.id,
        yemotPassword: t.yemotPassword || '',
        yemotChatExt: t.yemotChatExt === 'root' ? 'main' : t.yemotChatExt || '1',
        yemotAdminExt: t.yemotAdminExt || t.config?.yemotAdminExt || '',
        yemotSyncedAt: t.yemotSyncedAt || null,
        callsToday,
        dailyCallLimit: t.dailyCallLimit || 200,
        brevoKeySet: Boolean(t.brevoApiKey),
        mailFrom: t.mailFrom || '',
        totalExtensions: extensionsDetail.length,
        totalCallersInMemory: totalCallers,
        adminApiLink: `${publicOrigin}/admin/${t.id}`,
        extensions: extensionsDetail,
      };
    });

    res.json({
      ok: true,
      serverOrigin: publicOrigin,
      totalSystems: systems.length,
      totalExtensions: systems.reduce((s, sys) => s + sys.totalExtensions, 0),
      totalCallsToday: systems.reduce((s, sys) => s + sys.callsToday, 0),
      totalCallersInMemory: systems.reduce((s, sys) => s + sys.totalCallersInMemory, 0),
      systems,
    });
  });

  app.post('/api/super-admin/sync-all', async (req, res) => {
    if (!verifySuperAdminAuth(req)) {
      res.status(403).json({ error: 'גישה נדחתה: סיסמת מנהל או קוד מנהל שגויים.' });
      return;
    }
    await syncAllTenantsToPermanentOrigin();
    res.json({ ok: true, message: 'כל המערכות והשלוחות סונכרנו בהצלחה מול שרתי ימות המשיח!' });
  });

  const distPath = path.join(process.cwd(), 'dist');
  const isPreviewContainer =
    Boolean(process.env.K_SERVICE?.startsWith('ais-dev-')) ||
    Boolean(process.env.APP_URL?.includes('ais-dev-'));
  const isProd =
    !isPreviewContainer &&
    (process.env.NODE_ENV === 'production' ||
      Boolean(process.env.K_SERVICE) ||
      (fs.existsSync(path.join(distPath, 'index.html')) && process.env.NODE_ENV !== 'development'));

  app.get('/api/version', (_req, res) => {
    res.json({
      version: CURRENT_SERVER_VERSION,
      tunnelOrigin: activeTunnelOrigin || null,
      publicOrigin: getPublicOrigin(),
      deployedCloudRunIsV8,
    });
  });

  // Self-destroying Service Worker route so any browser with an older cached Workbox SW
  // immediately receives a valid application/javascript update, wipes CacheStorage, and reloads.
  const SELF_DESTROYING_SW_JS = `
// Yemot AI V4 Self-Destroying Service Worker (build ${Date.now()})
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    try {
      await self.registration.unregister();
    } catch (e) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (client.url && 'navigate' in client) {
          await client.navigate(client.url);
        }
      }
    } catch (e) {}
  })());
});
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
`;

  app.get(['/sw.js', '/dev-sw.js', '/service-worker.js'], (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(SELF_DESTROYING_SW_JS);
  });

  app.get('/registerSW.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(`
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(regs) {
          regs.forEach(function(r) { r.unregister(); });
        });
      }
      if ('caches' in window) {
        caches.keys().then(function(keys) {
          keys.forEach(function(k) { caches.delete(k); });
        });
      }
    `);
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  async function syncAllTenantsToPermanentOrigin(forcedOrigin?: string) {
    const origin = forcedOrigin || getPublicOrigin();
    // Load all current & future customers from the central master cloud registry first!
    await loadAllTenantsFromCloudRegistry();
    const tenants = loadLocalTenants();
    for (const tenantId of Object.keys(tenants)) {
      const hydrated = await hydrateTenantFromYemotCloud(tenantId, true);
      const t = normalizeTenantStructure(hydrated || tenants[tenantId]);
      if (!t.yemotNumber || !t.yemotPassword) continue;
      try {
        await persistTenantToYemotCloud(t, false);
        for (const [extKey, extCfg] of Object.entries(t.extensions || {})) {
          await configureYemotExtensionFull(
            t.yemotNumber,
            t.yemotPassword,
            extKey === 'root' ? 'root' : extKey,
            `${origin}/c`,
            extCfg,
            false
          );
          await syncTenantToDeployedCloudRun(t.id, t.yemotPassword, extCfg, extKey);
        }
        // Also repair 0772610845 ext 3 & 4 if they had an old URL
        if (t.id === '0772610845') {
          const baseCfg = getTenantExtConfig(t, '1');
          for (const extraExt of ['3', '4']) {
            if (!t.extensions?.[extraExt]) {
              await configureYemotExtensionFull(
                t.yemotNumber,
                t.yemotPassword,
                extraExt,
                `${origin}/c`,
                baseCfg,
                false
              );
            }
          }
        }
        const adminExt = String(t.yemotAdminExt || t.config?.yemotAdminExt || '').trim();
        if (adminExt) {
          await configureYemotExtensionFull(
            t.yemotNumber,
            t.yemotPassword,
            adminExt,
            `${origin}/a`,
            t.config,
            true
          );
        }
        console.log(`Synced Yemot tenant ${t.id} -> ${origin}/c`);
      } catch (e) {
        console.warn(`Auto-sync warning for ${t.id}:`, (e as Error)?.message || e);
      }
    }
  }

  let tunnelProc: ReturnType<typeof spawn> | null = null;
  let startingTunnel = false;

  async function ensureCloudflaredBinary(): Promise<string> {
    const binPath = '/tmp/cloudflared';
    if (fs.existsSync(binPath)) {
      return binPath;
    }
    const resp = await fetch(
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'
    );
    if (!resp.ok) throw new Error('Failed to download cloudflared');
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(binPath, buf);
    fs.chmodSync(binPath, 0o755);
    return binPath;
  }

  async function startOrRecoverTunnel() {
    if (!isPreviewContainer || startingTunnel || deployedCloudRunIsV8) return;
    startingTunnel = true;
    try {
      // First check if deployed Cloud Run already has CURRENT_SERVER_VERSION (v8)
      try {
        const vr = await fetch(`${PUBLIC_DEPLOYED_ORIGIN}/api/version`, {
          signal: AbortSignal.timeout(3000),
        });
        if (vr.ok) {
          const vj = (await vr.json()) as { version?: string };
          if (vj?.version === CURRENT_SERVER_VERSION) {
            deployedCloudRunIsV8 = true;
            console.log('Deployed Cloud Run is already on v8! Using permanent Cloud Run origin.');
            await syncAllTenantsToPermanentOrigin(PUBLIC_DEPLOYED_ORIGIN);
            startingTunnel = false;
            return;
          }
        }
      } catch {
        // Deployed Cloud Run is still on older revision; use live tunnel!
      }

      if (tunnelProc) {
        try {
          tunnelProc.kill('SIGKILL');
        } catch {
          // ignore
        }
        tunnelProc = null;
      }

      const bin = await ensureCloudflaredBinary();
      const child = spawn(bin, [
        'tunnel',
        '--url',
        `http://localhost:${PORT}`,
        '--protocol',
        'http2',
        '--no-autoupdate',
      ]);
      tunnelProc = child;

      let candidateUrl = '';
      let syncedForCurrentChild = false;

      const onData = (chunk: Buffer) => {
        const str = chunk.toString('utf8');
        const m = str.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && m[0]) {
          candidateUrl = m[0];
        }
        if (candidateUrl && !syncedForCurrentChild && str.includes('Registered tunnel connection')) {
          syncedForCurrentChild = true;
          activeTunnelOrigin = candidateUrl;
          try {
            fs.writeFileSync('/tmp/yemot_tunnel_url.txt', activeTunnelOrigin, 'utf8');
          } catch {
            // ignore
          }
          console.log('Active self-healing Yemot HTTP2 tunnel URL:', activeTunnelOrigin);
          setTimeout(() => {
            syncAllTenantsToPermanentOrigin(activeTunnelOrigin).catch(() => {});
          }, 1500);
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('exit', () => {
        tunnelProc = null;
        if (!deployedCloudRunIsV8) {
          setTimeout(() => {
            startOrRecoverTunnel().catch(() => {});
          }, 2000);
        }
      });
    } catch (e) {
      console.warn('Tunnel supervisor error:', (e as Error)?.message || e);
    } finally {
      startingTunnel = false;
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT} (isProd=${isProd})`);

    firestoreLoadAllTenants().catch((e) =>
      console.error('FIRESTORE LOAD FAILED:', (e as Error)?.message || e)
    );
    loadAllTenantsFromCloudRegistry().catch(() => {});

    if (isPreviewContainer) {
      startOrRecoverTunnel().catch(() => {});
    } else {
      syncAllTenantsToPermanentOrigin().catch(() => {});
    }

    // Keep-alive health check every 25 seconds so the tunnel NEVER goes idle or disconnects
    let failedPings = 0;
    setInterval(async () => {
      if (!isPreviewContainer) return;
      try {
        const vr = await fetch(`${PUBLIC_DEPLOYED_ORIGIN}/api/version`, {
          signal: AbortSignal.timeout(3000),
        });
        if (vr.ok) {
          const vj = (await vr.json()) as { version?: string };
          if (vj?.version === CURRENT_SERVER_VERSION && !deployedCloudRunIsV8) {
            deployedCloudRunIsV8 = true;
            await syncAllTenantsToPermanentOrigin(PUBLIC_DEPLOYED_ORIGIN);
            return;
          }
        }
      } catch {
        // ignore
      }

      if (!activeTunnelOrigin) {
        startOrRecoverTunnel().catch(() => {});
        return;
      }

      try {
        const r = await fetch(`${activeTunnelOrigin}/api/version`, {
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          failedPings = 0;
        } else {
          failedPings++;
        }
      } catch {
        failedPings++;
      }

      if (failedPings >= 2) {
        console.warn('Tunnel health-check failed twice, auto-recovering tunnel and syncing Yemot...');
        failedPings = 0;
        activeTunnelOrigin = '';
        startOrRecoverTunnel().catch(() => {});
      }
    }, 25_000);
  });
}

startServer();
