window.APP_CONFIG = {
    yandexProxy: '',
    yandexClientToken: '',
    webPushVapidPublicKey: 'YOUR_VAPID_PUBLIC_KEY',
    depotApiUrl: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',
    cloudtipsLayoutId: 'YOUR_LAYOUT_ID',
    cloudtipsPaymentUrl: 'https://pay.cloudtips.ru/p/YOUR_LAYOUT_ID',
    cloudtipsFeeApiUrl: 'https://api.cloudtips.ru/api/payment/fee',
    sheduleMax: {
        // Табло, нитки и справочники app (data/spr.json, shift-templates, instructions/…)
        s3BaseUrl: 'https://shedulemax-public.s3.cloud.ru',
        apiBaseUrl: '',
        functionUrl: '',
        useDirectS3: true,
        preferStopsApi: false,
        preferBoardApi: false,
        threadRev: 14,
        // Локально (8765 + Shedule_Max 8792):
        // apiBaseUrl: 'http://127.0.0.1:8792', preferStopsApi: true, preferBoardApi: true
    }
};
