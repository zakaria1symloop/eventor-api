/**
 * Draft Terms of Use and Privacy Policy (15 Oct 2026), served until an admin
 * replaces them in Settings · Legal with SYMLOOP's final text. Simple markdown:
 * `## ` headings, `- ` bullets, blank lines between paragraphs, `**bold**`.
 * `{deleteAccountUrl}` and `{supportContact}` are filled in when the page is served.
 */

export const LEGAL_DRAFT_DATE = '2026-10-15';

export const PRIVACY_EN = `Last updated: 15 October 2026

Eventor ("Eventor", "we", "us") is a marketplace that connects clients planning events in Algeria with event service providers such as venues, caterers, photographers and decorators. This policy explains which personal data we collect when you use the Eventor mobile app and website, why we use it, who we share it with, and the choices you have. We process personal data in accordance with Algerian Law No. 18-07 of 10 June 2018 on the protection of natural persons in the processing of personal data.

## 1. Data we collect

- **Account data:** your full name, email address, phone number, password (stored only as a secure hash), language, wilaya, and your profile photo if you add one.
- **Provider data:** for provider accounts, the business name and description, categories, the wilayas served, the services and ready packs with their photos, prices and availability, and the identity and business documents uploaded for verification (for example an identity document or a tax or commercial registration document).
- **Bookings:** the service or pack booked, the event date and times, the event address and commune, the number of guests, notes, prices, invoices, the booking history, check-ins and any disputes, including the evidence files uploaded.
- **Messages:** the messages and photos you send in chats with other users or with Eventor support.
- **Reviews and reports:** the reviews and replies you publish, and the reports you send about content or users.
- **Device and usage data:** your device model and app version (sent by your device as its User-Agent), your IP address, session information, the push notification token of your device, and the technical logs needed to keep the service secure.

We do not collect payment card data: bookings are paid in cash, directly between the client and the provider.

## 2. How we use your data

- To create and secure your account: email verification codes, sign-in and sessions.
- To run the marketplace: show providers and services, handle booking requests, invoices, chats, reviews and disputes.
- To verify providers before their services are published.
- To send you notifications and emails about your account and bookings. You can turn off push notifications and booking emails in the app settings; security emails are always sent.
- To moderate content, prevent fraud and abuse, and enforce our Terms of Use.
- To produce statistics that do not identify you.

We do not sell your personal data and we do not use it for third-party advertising.

## 3. Who can see your data

- **Other users:** everyone can see the public profile of providers, their services, packs, reviews and ratings, and the name and photo of review authors. A provider sees the details of the booking requests sent to them. Phone numbers and email addresses written in a chat stay hidden from the other person until a booking between you is accepted.
- **Eventor staff:** our team accesses data only to operate the service, provide support, verify providers and moderate content. Their actions are logged.
- **Companies working for us:** our hosting provider (servers and file storage), Google Firebase Cloud Messaging (to deliver push notifications) and our email provider (to send emails). They process data only on our instructions.
- **Authorities:** when the law requires it, or to protect the rights and safety of our users.

## 4. How long we keep data

- Account data is kept while your account is open.
- When you delete your account, your sessions and devices are removed at once and your email address and phone number are released at once; your name and photo are replaced with "Deleted user" after 30 days.
- Bookings, invoices and reviews are kept after the deletion, shown as "Deleted user": invoices are accounting records kept for the period the law requires, and reviews are part of the provider's history.
- Technical logs are kept for a limited time, for security.

## 5. Your rights

You can see and correct most of your data in the app (Profile). You can delete your account in the app (Profile, Delete account) or on the web: {deleteAccountUrl}. You can also ask us for a copy of your data, ask us to correct or delete it, or object to a use of it, by contacting us as shown in section 8.

## 6. Security

Passwords are stored as secure hashes, connections are encrypted (HTTPS), provider documents are stored privately and shown only through short-lived links, and access by our team is restricted and logged.

## 7. Children

Eventor is meant for people aged 18 and over. We do not knowingly collect data from children.

## 8. Contact

For any question about this policy or your data, contact Eventor: {supportContact}.

## 9. Changes

We may update this policy. The date at the top shows the current version, and we will tell you in the app about significant changes.
`.trim();

export const PRIVACY_AR = `آخر تحديث: 15 أكتوبر 2026

Eventor («Eventor» أو «نحن») منصة تربط العملاء الذين ينظمون مناسبات في الجزائر بمقدمي خدمات المناسبات مثل القاعات والممونين والمصورين ومنسقي الديكور. توضح هذه السياسة البيانات الشخصية التي نجمعها عند استخدامك لتطبيق Eventor وموقعه، وسبب استخدامها، ومن نشاركها معه، والخيارات المتاحة لك. نعالج البيانات الشخصية وفقًا للقانون الجزائري رقم 18-07 المؤرخ في 10 يونيو 2018 المتعلق بحماية الأشخاص الطبيعيين في مجال معالجة المعطيات ذات الطابع الشخصي.

## 1. البيانات التي نجمعها

- **بيانات الحساب:** اسمك الكامل، بريدك الإلكتروني، رقم هاتفك، كلمة المرور (تُحفظ فقط في صورة مشفرة آمنة)، اللغة، الولاية، وصورة الملف الشخصي إن أضفتها.
- **بيانات مقدمي الخدمات:** لحسابات مقدمي الخدمات: الاسم التجاري ووصفه، الفئات، الولايات المغطاة، الخدمات والباقات الجاهزة مع صورها وأسعارها وتوفرها، والوثائق الشخصية والتجارية المرفوعة للتحقق (مثل وثيقة الهوية أو وثيقة التسجيل الجبائي أو التجاري).
- **الحجوزات:** الخدمة أو الباقة المحجوزة، تاريخ المناسبة وتوقيتها، عنوانها وبلديتها، عدد الضيوف، الملاحظات، الأسعار، الفواتير، سجل الحجز، تأكيدات الحضور وأي نزاعات بما فيها ملفات الإثبات المرفوعة.
- **الرسائل:** الرسائل والصور التي ترسلها في المحادثات مع المستخدمين الآخرين أو مع دعم Eventor.
- **التقييمات والبلاغات:** التقييمات والردود التي تنشرها، والبلاغات التي ترسلها بشأن محتوى أو مستخدمين.
- **بيانات الجهاز والاستخدام:** طراز جهازك وإصدار التطبيق (يرسلهما جهازك في ترويسة User-Agent)، عنوان IP، معلومات الجلسة، رمز الإشعارات الخاص بجهازك، والسجلات التقنية اللازمة لحماية الخدمة.

لا نجمع بيانات البطاقات البنكية: تُدفع الحجوزات نقدًا مباشرة بين العميل ومقدم الخدمة.

## 2. كيف نستخدم بياناتك

- لإنشاء حسابك وحمايته: رموز التحقق عبر البريد، تسجيل الدخول والجلسات.
- لتشغيل المنصة: عرض مقدمي الخدمات والخدمات، ومعالجة طلبات الحجز والفواتير والمحادثات والتقييمات والنزاعات.
- للتحقق من مقدمي الخدمات قبل نشر خدماتهم.
- لإرسال الإشعارات والرسائل الإلكترونية الخاصة بحسابك وحجوزاتك. يمكنك إيقاف الإشعارات ورسائل الحجز من إعدادات التطبيق، أما رسائل الأمان فتُرسل دائمًا.
- لمراقبة المحتوى ومنع الاحتيال والإساءة وتطبيق شروط الاستخدام.
- لإعداد إحصائيات لا تكشف هويتك.

لا نبيع بياناتك الشخصية ولا نستخدمها لإعلانات أطراف أخرى.

## 3. من يمكنه رؤية بياناتك

- **المستخدمون الآخرون:** يمكن للجميع رؤية الملف العام لمقدمي الخدمات وخدماتهم وباقاتهم وتقييماتهم، واسم وصورة كاتب التقييم. يرى مقدم الخدمة تفاصيل طلبات الحجز المرسلة إليه. تبقى أرقام الهواتف وعناوين البريد المكتوبة في المحادثة مخفية عن الطرف الآخر إلى أن يُقبل حجز بينكما.
- **فريق Eventor:** لا يطّلع فريقنا على البيانات إلا لتشغيل الخدمة وتقديم الدعم والتحقق من مقدمي الخدمات ومراقبة المحتوى، وتُسجَّل عملياته.
- **الشركات التي تعمل لصالحنا:** مزود الاستضافة (الخوادم وتخزين الملفات)، وخدمة Google Firebase Cloud Messaging (لإيصال الإشعارات)، ومزود البريد الإلكتروني (لإرسال الرسائل). وهي تعالج البيانات وفق تعليماتنا فقط.
- **السلطات:** عندما يفرض القانون ذلك أو لحماية حقوق مستخدمينا وسلامتهم.

## 4. مدة الاحتفاظ بالبيانات

- تُحفظ بيانات الحساب طالما بقي حسابك مفتوحًا.
- عند حذف حسابك تُحذف جلساتك وأجهزتك فورًا ويُحرَّر بريدك الإلكتروني ورقم هاتفك فورًا، ويُستبدل اسمك وصورتك بعبارة «مستخدم محذوف» بعد 30 يومًا.
- تبقى الحجوزات والفواتير والتقييمات بعد الحذف باسم «مستخدم محذوف»: فالفواتير سجلات محاسبية تُحفظ المدة التي يفرضها القانون، والتقييمات جزء من سجل مقدم الخدمة.
- تُحفظ السجلات التقنية لمدة محدودة لأغراض الأمان.

## 5. حقوقك

يمكنك الاطلاع على معظم بياناتك وتصحيحها في التطبيق (الملف الشخصي). ويمكنك حذف حسابك من التطبيق (الملف الشخصي، حذف الحساب) أو من الويب: {deleteAccountUrl}. كما يمكنك طلب نسخة من بياناتك أو تصحيحها أو حذفها أو الاعتراض على استخدامها بالتواصل معنا كما هو مبين في البند 8.

## 6. الأمان

تُحفظ كلمات المرور في صورة مشفرة آمنة، والاتصالات مشفرة (HTTPS)، وتُخزَّن وثائق مقدمي الخدمات بشكل خاص ولا تُعرض إلا عبر روابط مؤقتة، والوصول إليها من فريقنا محدود ومسجَّل.

## 7. الأطفال

Eventor موجهة للأشخاص البالغين 18 سنة فما فوق. لا نجمع عن قصد أي بيانات خاصة بالأطفال.

## 8. التواصل

لأي سؤال حول هذه السياسة أو بياناتك، تواصل مع Eventor: {supportContact}.

## 9. التعديلات

قد نحدّث هذه السياسة. يبيّن التاريخ في الأعلى النسخة الحالية، وسنعلمك داخل التطبيق بأي تغيير مهم.
`.trim();

export const TERMS_EN = `Last updated: 15 October 2026

These terms govern your use of the Eventor mobile app and website. By creating an account or using Eventor you accept them. If you do not accept them, do not use Eventor.

## 1. The service

Eventor is a marketplace that connects clients with event service providers in Algeria. Eventor is not a party to the agreement between a client and a provider: the provider is responsible for the services they offer and deliver, and the client for the information they give and for paying the provider.

## 2. Your account

- You must be at least 18 years old and give accurate information.
- Keep your password secret: you are responsible for what happens on your account.
- Providers must complete the verification. Eventor may refuse or remove a provider whose documents or information are not valid.
- One person or business per account. Do not create an account for someone else without their permission.

## 3. Bookings and payment

- A booking request is confirmed only when the provider accepts it.
- Prices are set by providers and shown in Algerian dinars. Payment is made directly between the client and the provider, in cash; Eventor does not collect payments in the app.
- Each service shows its cancellation policy. Clients and providers must respect the bookings they accept.
- If something goes wrong, you can open a dispute in the app. Eventor reviews the information from both sides and decides on the dispute, but is not responsible for refunds between users.

## 4. Content and conduct

You are responsible for what you publish: profile, services, photos, messages and reviews. **Eventor has zero tolerance for objectionable content and abusive users.** You must not:

- publish content that is illegal, hateful, violent, sexually explicit, harassing, threatening, defamatory or discriminatory;
- harass, insult, threaten or spam other users;
- publish fake reviews, fake services or misleading information, or impersonate someone;
- share another person's personal data without their consent;
- use Eventor for any illegal purpose;
- try to break, overload or get around the security of the service.

A review must describe a real experience of a completed booking.

## 5. Reporting and blocking

You can report any message, review, service, pack or user from the app, and block a user so that they can no longer message you or send you booking requests. Eventor reviews reports within 24 hours and may remove content, hide services, close chats, and suspend or delete accounts that break these terms, without notice.

## 6. Intellectual property

You keep the rights to the content you publish, and you allow Eventor to show it in the app and on the website to run and promote the service. The Eventor name, logo and app belong to Eventor.

## 7. Liability

Eventor provides the platform as it is and does its best to keep it available and accurate, but does not guarantee the quality, safety or legality of the services offered by providers, nor the behaviour of users. As far as the law allows, Eventor is not liable for indirect damage or for losses arising from agreements between users.

## 8. Closing your account

You can delete your account at any time, in the app or on the web: {deleteAccountUrl}. Eventor may suspend or close an account that breaks these terms.

## 9. Changes and applicable law

We may update these terms. The date at the top shows the current version, and continuing to use Eventor means that you accept it. These terms are governed by Algerian law.

## 10. Contact

For any question about these terms, contact Eventor: {supportContact}.
`.trim();

export const TERMS_AR = `آخر تحديث: 15 أكتوبر 2026

تنظّم هذه الشروط استخدامك لتطبيق Eventor وموقعه. بإنشائك حسابًا أو استخدامك Eventor فإنك توافق عليها. إن لم توافق عليها فلا تستخدم Eventor.

## 1. الخدمة

Eventor منصة تربط العملاء بمقدمي خدمات المناسبات في الجزائر. Eventor ليست طرفًا في الاتفاق بين العميل ومقدم الخدمة: فمقدم الخدمة مسؤول عن الخدمات التي يعرضها ويقدمها، والعميل مسؤول عن المعلومات التي يقدمها وعن الدفع لمقدم الخدمة.

## 2. حسابك

- يجب أن يكون عمرك 18 سنة على الأقل وأن تقدم معلومات صحيحة.
- حافظ على سرية كلمة المرور: أنت مسؤول عما يحدث في حسابك.
- يجب على مقدمي الخدمات إكمال التحقق. يمكن لـ Eventor رفض أو إزالة أي مقدم خدمة تكون وثائقه أو معلوماته غير صالحة.
- حساب واحد لكل شخص أو مؤسسة. لا تنشئ حسابًا لشخص آخر دون إذنه.

## 3. الحجوزات والدفع

- لا يُؤكَّد طلب الحجز إلا عندما يقبله مقدم الخدمة.
- يحدد مقدمو الخدمات الأسعار وتُعرض بالدينار الجزائري. يتم الدفع مباشرة بين العميل ومقدم الخدمة نقدًا، ولا تحصّل Eventor أي مدفوعات داخل التطبيق.
- تعرض كل خدمة سياسة الإلغاء الخاصة بها. يجب على العملاء ومقدمي الخدمات احترام الحجوزات التي يقبلونها.
- إذا حدث خلل، يمكنك فتح نزاع في التطبيق. تراجع Eventor معلومات الطرفين وتفصل في النزاع، لكنها غير مسؤولة عن أي استرداد بين المستخدمين.

## 4. المحتوى والسلوك

أنت مسؤول عما تنشره: الملف الشخصي والخدمات والصور والرسائل والتقييمات. **لا تتسامح Eventor إطلاقًا مع المحتوى المسيء والمستخدمين المسيئين.** يُمنع عليك:

- نشر محتوى غير قانوني أو يحض على الكراهية أو العنف أو ذي طابع جنسي صريح أو مضايق أو مهدد أو تشهيري أو تمييزي؛
- مضايقة المستخدمين الآخرين أو إهانتهم أو تهديدهم أو إرسال رسائل مزعجة لهم؛
- نشر تقييمات أو خدمات مزيفة أو معلومات مضللة، أو انتحال شخصية أحد؛
- مشاركة البيانات الشخصية لشخص آخر دون موافقته؛
- استخدام Eventor لأي غرض غير قانوني؛
- محاولة تعطيل الخدمة أو إثقالها أو تجاوز أنظمة حمايتها.

يجب أن يصف التقييم تجربة حقيقية لحجز مكتمل.

## 5. الإبلاغ والحظر

يمكنك الإبلاغ عن أي رسالة أو تقييم أو خدمة أو باقة أو مستخدم من داخل التطبيق، وحظر أي مستخدم حتى لا يتمكن من مراسلتك أو إرسال طلبات حجز إليك. تراجع Eventor البلاغات خلال 24 ساعة، ويمكنها حذف المحتوى وإخفاء الخدمات وإغلاق المحادثات وتعليق أو حذف الحسابات المخالفة لهذه الشروط دون إشعار مسبق.

## 6. الملكية الفكرية

تحتفظ بحقوقك على المحتوى الذي تنشره، وتسمح لـ Eventor بعرضه في التطبيق وعلى الموقع لتشغيل الخدمة والترويج لها. اسم Eventor وشعارها وتطبيقها ملك لـ Eventor.

## 7. المسؤولية

توفر Eventor المنصة كما هي وتبذل جهدها لإبقائها متاحة ودقيقة، لكنها لا تضمن جودة الخدمات المقدمة من مقدمي الخدمات أو سلامتها أو قانونيتها، ولا سلوك المستخدمين. وفي حدود ما يسمح به القانون، لا تتحمل Eventor المسؤولية عن الأضرار غير المباشرة أو الخسائر الناتجة عن الاتفاقات بين المستخدمين.

## 8. إغلاق حسابك

يمكنك حذف حسابك في أي وقت من التطبيق أو من الويب: {deleteAccountUrl}. ويمكن لـ Eventor تعليق أو إغلاق أي حساب يخالف هذه الشروط.

## 9. التعديلات والقانون المطبق

قد نحدّث هذه الشروط. يبيّن التاريخ في الأعلى النسخة الحالية، ومواصلتك استخدام Eventor تعني موافقتك عليها. تخضع هذه الشروط للقانون الجزائري.

## 10. التواصل

لأي سؤال حول هذه الشروط، تواصل مع Eventor: {supportContact}.
`.trim();
