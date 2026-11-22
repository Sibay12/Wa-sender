# WhatsApp Auto Sender

## चलाने का तरीका
1. Node.js 18+ install करें
2. `npm install`
3. `npm start`
4. ब्राउज़र में http://localhost:3000 खोलें, पहली बार QR स्कैन करें (सेशन `session/` फ़ोल्डर में सेव रहता है)
5. Excel अपलोड करें, मैसेज चेक करें, "भेजना शुरू करें" दबाएँ

## Excel फ़ॉर्मेट
| Business Name | Mobile Number | Rating |
|---|---|---|
| Doon Valley Holistic Wellness & Yoga | 9876543210 | 4.8 |

## सेटिंग (environment variables)
- `MIN_DELAY_SEC` / `MAX_DELAY_SEC`: मैसेज के बीच गैप (default 20-45 सेकंड)
- `DEFAULT_COUNTRY_CODE`: 10 अंक वाले नंबर के आगे जुड़ेगा (default 91)
- `PORT`: default 3000

## सावधानी
पहले अपने दो-तीन नंबरों पर टेस्ट करें। एक दिन में 30-50 से ज़्यादा नए नंबरों को न भेजें, वरना नंबर बैन हो सकता है।
सर्वर पर चलाएँ तो पासवर्ड/लॉगिन ज़रूर लगाएँ, वरना कोई भी आपके WhatsApp से मैसेज भेज सकता है।
