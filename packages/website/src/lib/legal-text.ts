export type LegalDocument = "terms" | "privacy";

export const LEGAL_TITLES: Record<LegalDocument, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
};

export const LEGAL_LAST_UPDATED = "September 8, 2026";
export const PRIVACY_LAST_UPDATED = "September 8, 2026";

export const TERMS_OF_SERVICE = `Stella — FromYou LLC
Last updated: ${LEGAL_LAST_UPDATED}

These Terms of Service ("Terms") govern your use of Stella, including the desktop application, mobile companion app, backend services, and any related websites or APIs (collectively, the "Service"), operated by FromYou LLC, a Delaware limited liability company ("FromYou," "we," "us," or "our").

By accessing or using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service.


1. Beta Status

Stella is currently in beta. The Service is provided on an "as-is" and "as-available" basis. Features, pricing, availability, and functionality may change, be limited, or be discontinued at any time without prior notice. We make no guarantees regarding uptime, reliability, or the continued availability of any particular feature during the beta period.


2. Eligibility

You must be at least 13 years of age to use the Service. If you are under 18, you represent that your parent or legal guardian has reviewed and agreed to these Terms on your behalf.


3. Accounts and Authentication

Anonymous Use — Stella can be used without creating an account. Anonymous users receive access to core functionality subject to rate limits.

Registered Accounts — You may optionally create an account using magic-link email authentication or Google sign-in. If you create an account, you are responsible for maintaining the security of your login credentials and for all activity that occurs under your account.

Account Linking — If you upgrade from anonymous use to a registered account, any anonymous session data may be linked to your new account.


4. Description of the Service

The Stella Platform — Stella is a personal AI assistant available through desktop, web, and mobile applications. It coordinates agents that perform tasks on your device or through hosted services.

The Stella Provider (Managed LLM Service) — FromYou operates the Stella Provider, a managed LLM inference service that routes AI model requests to upstream providers on your behalf. Free and paid plans provide different managed usage limits and capabilities. You may also supply your own API keys (BYOK) for supported model calls, although some capabilities require a paid Stella plan.

Additional Backend Services — Our backend also provides authentication, mobile and connector delivery, usage and billing services, connected-service access, web search, and media generation capabilities.


5. Your Data

Service Data — Stella stores messages, conversation history, and related content in our cloud infrastructure to provide the Service. Related content may include attachments, memories, agent activity, and tool results. Our infrastructure and third-party providers process the content needed to carry out your requests. The Privacy Policy explains storage, processing, retention, and deletion in more detail.

Mobile and Connector Delivery — When you use Stella from the mobile app or a connected messaging service, content and delivery state may pass through and be temporarily stored by our backend so a device or service can claim, process, cancel, complete, and deliver the request.

Discovery Signals — During onboarding, Stella may optionally collect signals from your device (browser bookmarks, installed applications, development environment, etc.) to personalize your experience. Discovery data may be processed and stored by the Service to personalize your experience. Contact information and personal identifiers are pseudonymized locally before use. Discovery categories involving sensitive data (messages, notes) are opt-in and disabled by default.

Stella Mobile App — When you pair the Stella mobile app with your desktop, messages are routed to your desktop when available. Pairing and routing metadata, request content, delivery state, and related records may be processed or stored on our backend as needed to provide mobile access.


6. Computer Use and Agent Autonomy

What Stella Can Do on Your Computer — Stella's AI agents can perform actions on your computer on your behalf, including but not limited to: reading, writing, editing, and deleting files and directories; executing shell commands and running scripts; browsing the web, clicking links, filling forms, and navigating websites; capturing screenshots and reading on-screen content; opening applications and interacting with your operating system; modifying Stella's own user interface and code; scheduling automated tasks that run in the background; and interacting with connected services and APIs.

Your Responsibility — You are solely and entirely responsible for all actions that Stella's AI agents perform on your computer and accounts. Stella acts as a tool under your direction. When you instruct Stella to perform a task, you authorize it to take the actions necessary to complete that task, including any intermediate steps the AI determines are needed.

You acknowledge and agree that: AI agents may take actions that produce unintended, incorrect, or irreversible results, including data loss, file deletion, unintended purchases, unauthorized access to services, or system damage. It is your responsibility to review, supervise, and verify the actions taken by AI agents. You should not grant Stella access to systems or accounts where unintended actions could cause harm you are unwilling to accept. FromYou does not control, review, or approve the specific actions an AI agent takes in response to your instructions. The AI's behavior is determined by the underlying language model, your prompts, your system configuration, and the tools available. FromYou is not liable for any loss, damage, cost, or consequence resulting from actions performed by Stella's AI agents on your device, accounts, or connected services, regardless of whether those actions were intended, expected, or authorized by you.

Safety Mechanisms — Stella includes certain safety mechanisms (e.g., command safety checks, network guards, security policies, confirmation prompts for sensitive operations). These mechanisms are provided as a convenience and are not guaranteed to prevent all harmful actions. You should not rely on them as a substitute for your own judgment and supervision.


7. AI Services and the Stella Provider

Managed LLM Inference (Stella Provider) — When you use Stella's managed AI, model requests are routed through our infrastructure to third parties that provide AI infrastructure and model access. Depending on the selected model, routing, and feature, these may include OpenAI, Anthropic, Google, xAI, OpenRouter, or Fireworks. We process prompts, attachments, model context, outputs, and metadata needed to provide the request. We do not intentionally retain provider request content as a model-training product, but our systems may buffer response content temporarily for streaming and recovery and retain usage, security, and billing metadata.

Bring Your Own Keys (BYOK) — You may configure your own API keys for supported AI providers (Anthropic, OpenAI, Google, etc.). When using BYOK, supported model requests are sent directly from your device to the provider, and our managed model relay is not involved in those calls. Your API keys are stored locally on your device in encrypted form. Some Stella capabilities still require a paid plan.

Third-Party AI Providers — Whether using managed AI or BYOK, prompts and model inputs, including text, images, files, and related context, are processed by third-party AI services. Those providers may retain prompts, outputs, files, or metadata under their own terms, policies, and account configurations. Stella does not promise that every provider request receives zero-data-retention treatment. FromYou does not control provider practices and is not responsible for the outputs, accuracy, or behavior of any third-party AI model.

Media Generation and Search — Stella offers media generation and web search through third-party providers, including fal.ai and Exa, with other providers used depending on the feature. Prompts, files, search queries, generated outputs, and metadata may be sent to and retained by those providers under their own terms and configurations. Stella may also store encrypted submission payloads temporarily and store generated media or references as needed to deliver and manage the feature.


8. Subscription Plans and Billing

Free Use — Stella offers a free plan. Some capabilities, including managed media generation, require a paid plan even if you supply your own model API keys.

Stella Provider Plans — The Stella Provider LLM inference service offers a free tier with rate-limited access, as well as paid subscription plans (currently Go and Pro) with higher usage limits and, depending on the plan, additional capabilities. Paid plans are billed monthly through Stripe.

Pricing Changes — All prices are subject to change at any time, including during the beta period. We will make reasonable efforts to notify active subscribers of pricing changes in advance. Continued use of a paid plan after a price change constitutes acceptance of the new pricing.

Usage Limits — Each plan includes usage limits. If you exceed a limit, access to managed services may be temporarily restricted.

Cancellation — You may cancel your subscription at any time. Cancellation takes effect at the end of the current billing period. No refunds are provided for partial billing periods.


9. User-Created Apps and Projects

Stella can create or modify projects in local workspaces on your device. These projects are separate from the packaged Stella application. You are responsible for reviewing generated code and deciding when to run, share, or publish it.


10. Acceptable Use

You agree not to: use the Service for any unlawful purpose or to violate any applicable law or regulation; attempt to gain unauthorized access to any part of the Service or its related systems; interfere with or disrupt the Service, servers, or networks connected to the Service; use the Service to generate content that is illegal, harmful, threatening, abusive, harassing, defamatory, or otherwise objectionable; circumvent any rate limits, usage restrictions, or access controls; reverse-engineer, decompile, or disassemble any proprietary component of the Service except to the extent applicable law permits; use the Service to build a competing product or service by systematically extracting data from our backend APIs; or resell access to the Stella Provider or backend services without our written permission.


11. Intellectual Property

Our Rights — The Stella name, logo, branding, hosted backend services, API infrastructure, and proprietary components are the intellectual property of FromYou or its licensors.

Your Rights — You retain all rights to your data, conversations, and any content you create using the Service, subject to any rights needed for us and our service providers to operate features you choose to use.


12. Disclaimer of Warranties

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. FROMYOU DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE. THE SERVICE IS IN BETA AND MAY CONTAIN BUGS, ERRORS, AND INCOMPLETE FEATURES.

AI-GENERATED CONTENT MAY BE INACCURATE, INCOMPLETE, OR INAPPROPRIATE. YOU ARE SOLELY RESPONSIBLE FOR EVALUATING AND USING AI-GENERATED OUTPUT. FROMYOU IS NOT LIABLE FOR ANY ACTIONS TAKEN BASED ON AI-GENERATED CONTENT OR ANY ACTIONS PERFORMED BY STELLA'S AI AGENTS ON YOUR COMPUTER, ACCOUNTS, OR CONNECTED SERVICES, INCLUDING BUT NOT LIMITED TO CODE EXECUTION, FILE CREATION OR DELETION, SHELL COMMANDS, WEB BROWSING, FORM SUBMISSIONS, PURCHASES, DATA TRANSMISSION, OR ANY OTHER OPERATION THE AGENT PERFORMS. YOU USE STELLA'S COMPUTER-USE CAPABILITIES ENTIRELY AT YOUR OWN RISK.


13. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, FROMYOU SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, LOSS OF PROFITS, DAMAGE TO YOUR DEVICE OR SYSTEMS, UNAUTHORIZED ACCESS TO YOUR ACCOUNTS, UNINTENDED PURCHASES OR TRANSACTIONS, OR ANY OTHER HARM ARISING FROM ACTIONS PERFORMED BY STELLA'S AI AGENTS, REGARDLESS OF THE THEORY OF LIABILITY.

WITHOUT LIMITING THE FOREGOING, FROMYOU SHALL NOT BE LIABLE FOR ANY DAMAGES ARISING FROM: (A) ACTIONS TAKEN BY AI AGENTS ON YOUR COMPUTER OR ACCOUNTS; (B) INACCURATE, INCOMPLETE, OR HARMFUL AI-GENERATED OUTPUT; (C) MODS OR EXTENSIONS CREATED BY THIRD PARTIES; (D) INTERRUPTIONS OR ERRORS IN THE STELLA PROVIDER INFERENCE SERVICE; OR (E) THE ACTS OR OMISSIONS OF THIRD-PARTY AI MODEL PROVIDERS.

OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID TO FROMYOU FOR THE STELLA PROVIDER IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR (B) FIFTY DOLLARS ($50).


14. Indemnification

You agree to indemnify and hold harmless FromYou, its officers, directors, employees, and agents from any claims, liabilities, damages, losses, or expenses (including reasonable attorneys' fees) arising out of or related to: (a) your use of the Service, including any actions taken by AI agents on your behalf; (b) your violation of these Terms; (c) projects you create, run, or publish with Stella; (d) your violation of any third-party rights; or (e) any consequences of computer-use actions performed by Stella on your device, accounts, or connected services.


15. Third-Party Services

The Service integrates with third-party services including AI model providers, Stripe for payments, fal.ai for media generation, and messaging platforms. Your use of these services is subject to their respective terms. We are not responsible for the availability, accuracy, or practices of any third-party service.


16. Termination

We may suspend or terminate your access to the Service at any time, with or without cause, with or without notice. You may stop using the Service at any time. Upon termination, your right to use the hosted services ceases. Retention and deletion of your information are described in the Privacy Policy.


17. Governing Law and Dispute Resolution

These Terms are governed by the laws of the State of Delaware, without regard to its conflict-of-law provisions. Any dispute arising under these Terms shall be resolved in the state or federal courts located in Delaware, and you consent to personal jurisdiction in those courts.


18. Changes to These Terms

We may update these Terms from time to time. We will indicate the date of the most recent revision at the top of this page. Your continued use of the Service after any changes constitutes acceptance of the updated Terms. For material changes, we will make reasonable efforts to notify you (e.g., through the application or by email if you have an account).


19. Severability

If any provision of these Terms is found to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.


20. Entire Agreement

These Terms, together with our Privacy Policy, constitute the entire agreement between you and FromYou regarding the Service and supersede any prior agreements.


21. Contact Us

If you have questions about these Terms, contact us at:

FromYou LLC
131 Continental Drive, Suite 305
Newark, DE 19713

Email: contact@fromyou.ai`;

export const PRIVACY_POLICY = `Stella — FromYou LLC
Last updated: ${PRIVACY_LAST_UPDATED}

This Privacy Policy describes how FromYou LLC ("FromYou," "we," "us," or "our") handles information when you use Stella, including the desktop application, mobile companion app, backend services, and related websites or APIs (collectively, the "Service").

Stella stores messages, conversation history, and related content in our cloud infrastructure. We and our service providers process information to respond to your requests, run agents, maintain your conversation, and operate the Service.


1. Conversation and Account Content

We store your messages and Stella's replies as part of your conversation history. Depending on how you use Stella, related content may include attachments, uploaded files, generated outputs, memories, voice transcripts, agent activity, and tool results. This storage applies to ordinary conversations, including conversations started in the desktop app.


2. Information Used for Tasks

When you ask Stella to work with files, websites, applications, or connected services, it may read and process relevant content. This can include file excerpts, screenshots, screen content, web pages, messages, notes, calendar entries, shell commands, and their output. Content included in a conversation or agent activity may be stored with that history and sent to the providers needed to complete the task.

Optional onboarding discovery may collect information such as bookmarks, installed applications, and development environment details to personalize Stella. You can choose which available discovery categories to enable.


3. Device Data and Deletion

The applications may keep caches, preferences, credentials, and workspace files on your device. Removing the application or deleting its device data does not delete your stored conversations or other hosted account content. See the retention and rights sections below for how to request deletion of that information.


4. Information Processed by Our Services

Depending on the features you use, our backend may process or store:

Stella Provider (Managed LLM Inference) — When you use managed AI, your prompt, attachments, relevant conversation context, tool definitions or results, and model output pass through our infrastructure to the provider selected for the request. Depending on the model and routing path, providers may include OpenAI, Anthropic, Google, xAI, OpenRouter, or Fireworks. We record usage and operational metadata such as owner or anonymous identifier, model, agent type, token counts, duration, estimated cost, plan, timestamp, and success or failure. We do not intentionally retain provider request content as a model-training product. We may temporarily buffer plaintext response text, reasoning, and tool arguments for stream recovery; current relay access expires after brief inactivity and has a hard ten-minute lifetime, while cleanup and security records may persist longer. When a BYOK call goes directly from your device to your selected provider, FromYou's managed model relay is not involved, but the provider still processes the request under its own terms.

Mobile and Connector Delivery — When you interact through the mobile app or a connected messaging service, our backend may store request text or references, delivery and routing metadata, request state, stream state, and response delivery data so a desktop or service can claim, cancel, complete, and deliver the work. Records are deleted or expire according to operational cleanup rules, which vary by record type.

Media, Search, and Connected Services — Media prompts, uploaded files, generated outputs, search queries, search results, and connected-service content may pass through our infrastructure. Stella may temporarily store encrypted media submission payloads and may store generated media, references, job state, or connected-service records as needed to deliver and manage those features.

Other Hosted Content — Publishing, social or collaboration features, and other hosted features store the content and metadata needed to provide them.


5. Computer Use and Agent Activity Data

Stella's agents can browse the web, execute commands, read and write files, and interact with applications on your behalf. Agents may run on your device or through hosted services. Relevant inputs, outputs, screenshots, and activity records may be processed by our infrastructure and providers and stored as part of your conversation or task history.

Using your own model provider does not change Stella's storage of conversation and task history. The provider also processes submitted content under its own policies.


6. Information We Collect When You Create an Account

Account creation is optional. If you choose to sign in, we collect: your email address (for authentication and account identification), your name if provided (for display purposes), and your account creation timestamp (for account management).

We use Better Auth for authentication, with magic-link email sign-in and optional Google sign-in. We do not collect passwords.


7. Billing Information

If you subscribe to a paid Stella Provider plan, payment is processed by Stripe. We store: Stripe customer ID (linking your account to Stripe), subscription status and plan (determining your access level), payment method brand and last 4 digits (displaying payment info in settings), billing period dates (usage window tracking), and usage totals in micro-cents (enforcing plan limits).

We do not store your full credit card number, CVV, or banking details. All payment processing is handled by Stripe under their privacy policy.


8. Device Information

When your desktop registers with our backend (for mobile bridge or connector functionality), we store: device ID (identifying your desktop for message routing), device public key (verifying device identity via cryptographic signatures), online status (determining whether to route to your device or the offline responder), platform — Windows/macOS (display purposes), and mobile bridge base URLs (allowing your phone to connect to your desktop).


9. Anonymous Device Usage

If you use Stella without an account, we track: an anonymous device identifier (for rate limiting) and request count and timestamps (for enforcing fair-use limits). This data is not linked to any personal identity.


10. Website Advertising Measurement

If you arrive at the Stella website through a Google Ads click, we use the Google tag to measure whether that advertising visit leads to a Stella download. For those advertising referrals, Google may receive the ad click identifier (such as GCLID, GBRAID, or WBRAID), page and device information ordinarily sent by your browser, and a download conversion event. We retain a first-party attribution flag in your browser for up to 30 days so a later download can be associated with the advertising visit. The tag is not loaded for visitors who did not arrive through a Google Ads referral.

We use this information only for aggregate advertising measurement and campaign optimization. We do not use enhanced conversions, do not send customer-provided data such as email addresses to Google for this purpose, and do not use this measurement for remarketing or targeted advertising. Google processes this information under its own privacy policy and data-processing terms. You can prevent or clear this measurement by blocking advertising cookies or clearing this site's local storage and cookies.


11. Social Features

If you use Stella's social features (friend system, chat rooms, collaborative sessions), the following is stored on our backend: social profile (username), friend relationships, chat room membership and messages, and collaborative session metadata and file operations. Social features are opt-in and require a signed-in account.


12. Third-Party Services and Provider Retention

Stella uses third-party services including AI gateways and model providers (which may include OpenAI, Anthropic, Google, xAI, OpenRouter, and Fireworks), fal.ai and other media providers, Exa and other search providers, Convex for backend infrastructure, Stripe for billing, authentication and connected-service vendors, and Google Ads for advertising-referred download measurement.

These providers process data under their own terms, privacy policies, and account configurations. Depending on the provider and feature, they may retain prompts, outputs, uploaded files, generated media, search requests, or metadata for safety, abuse prevention, service operation, or other stated purposes. Some providers offer optional or account-specific zero-data-retention controls, but availability and coverage vary. FromYou does not make a blanket zero-data-retention promise for third-party processing. When using BYOK, a model request may go directly from your device to the provider, but that does not change the provider's own practices.


13. Google Workspace Connector and Google API Services User Data

Stella includes a first-party Google Workspace connector that you can optionally enable to let Stella work with your Google account across Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, and Google Tasks. This section describes how that connector handles data received from Google APIs and applies in addition to the rest of this policy.

How You Connect — The connector is off until you choose to connect it, and connecting is always optional. Connecting starts a Google OAuth consent flow in which you sign in to Google and approve the access. You can connect Google services granularly — enabling one service at a time (for example, just Gmail or just Calendar), which incrementally expands a single shared Google grant to add each service's scopes — or use the one-tap Google Workspace bundle to enable all of the services listed above at once. A single consent screen does not necessarily cover every service; a granular connection requests only the scopes for the service you are enabling, and you review and approve the requested scopes on Google's consent screen before access is granted.

Data and Scopes We Access — When connected, only for the services you have connected and only as needed to carry out tasks you ask Stella to perform, the connector can access:

• Basic account identity — your Google account email address, basic profile, and an OpenID identifier, used to identify the connected account (scopes: openid, userinfo.email, userinfo.profile)
• Gmail — read, compose, send, and organize your messages, drafts, and labels; this does not include permanently deleting mail (scope: gmail.modify)
• Google Calendar — view and manage your calendars and events (scope: calendar)
• Google Drive — view and manage files in your Drive (scope: drive)
• Google Docs — create, read, and edit your documents (scope: documents)
• Google Sheets — create, read, and edit your spreadsheets (scope: spreadsheets)
• Google Tasks — view and manage your task lists (scope: tasks)

User-Directed Use — Stella accesses and acts on your Google data only after you connect the account and direct Stella (or a Stella agent acting on your instruction) to perform a task, such as reading an email, scheduling an event, or editing a document. Stella does not access your Google data for purposes you have not requested.

Where Your Credentials Live — Depending on how you run the connector, your Google OAuth tokens are stored in one of two ways. For on-device (local) execution, the OAuth access and refresh tokens Google issues are stored on your own device in Stella's protected credential store, encrypted at rest using your operating system's secure storage (the OS keychain or credential vault, via the desktop framework's safeStorage). For cloud or Store-based execution — where Stella carries out connector actions on your behalf from our backend — the tokens are persisted in FromYou's server-side credential vault, encrypted at rest using AES-256-GCM with a versioned master key. In both cases the confidential OAuth client secret is held only by FromYou's backend and is never shipped inside the app.

How Google Data Is Processed — Stella uses your connected Google account to carry out the tasks you request. Relevant content returned by Google APIs, such as emails, events, documents, or spreadsheets, may be processed by our services and stored in conversation history, tool results, or task records. When you direct Stella to reason over this content, it may be sent to the AI model provider handling your request and to service providers needed to operate that feature. We do not use Google Workspace data to develop, train, or improve generalized artificial-intelligence or machine-learning models.

No Sale, Advertising, or Credit Use — We do not sell or rent data received from Google APIs, and we do not transfer or use it to serve advertising or to determine creditworthiness or for lending purposes.

Restricted Human Access — FromYou personnel do not read data obtained through the Google connector, except where you give explicit consent to view specific data (for example, for support you request), where necessary for security purposes such as investigating abuse, where required to comply with applicable law, or where the data has been aggregated and anonymized for internal operations.

Retention, Deletion, and Revocation — Google tokens are retained while the connection remains active. Disconnecting the service removes the associated credentials. Google content included in conversation history or task records follows the retention and deletion practices described below; disconnecting a service does not delete that history. You can revoke Stella's access at any time from your Google Account under Security → Third-party access (https://myaccount.google.com/permissions), which invalidates the tokens held both on your device and in the vault; you can also disconnect individual services within Stella to remove just those services' access.

Limited Use — Stella's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy (https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.


14. Data Retention

• Conversation and task content — retained to provide your history and the Service until deleted through available controls or an eligible deletion request, subject to legal, security, and operational retention needs
• Device data — removing device data does not delete hosted content
• Account information — until you delete your account
• Billing records — as required by law and for dispute resolution (typically 7 years for financial records)
• Usage and operational metadata — retained as needed for billing reconciliation, rate limiting, security, and service operation
• Temporary relay buffers — brief operational windows for stream recovery, subject to cleanup and hard lifetime limits
• Mobile and connector delivery records — retained according to operational delivery, deduplication, and cleanup periods that vary by record type
• Media inputs, outputs, and job records — retained as needed to submit, deliver, manage, and clean up media jobs; third-party copies follow provider policies
• Anonymous device usage — retained for rate-limiting purposes; periodically pruned
• Google Ads attribution flag — stored in your browser for up to 30 days
• Social data — until you delete your account or the relevant content


15. Data Security

We implement reasonable security measures to protect data in our infrastructure: encryption in transit (all communication uses TLS/HTTPS), secret encryption (user-provided secrets stored on our backend are encrypted using AES-256-GCM with a versioned master key system), local encryption (API keys stored on your device are encrypted locally), device identity (devices authenticate using Ed25519 cryptographic keypairs), rate limiting (multi-layer rate limiting protects against abuse), and provider redaction (AI responses are scrubbed of upstream provider details before being returned to you).


16. Your Rights and Choices

Access and Control — You can use available in-app controls to manage your information, revoke connected integrations, and contact us to request access to, export of, or deletion of your conversation history and eligible account data. Some records may be retained where required for legal, security, fraud-prevention, billing, or dispute-resolution purposes. Deleting data from Stella does not necessarily delete copies retained by third-party providers under their policies.

Discovery Opt-Out — During onboarding, each discovery category is individually selectable. The most sensitive category (Messages & Notes) is disabled by default and requires explicit opt-in. You can skip discovery entirely.

Anonymous Use — You can use Stella's core features without creating an account or providing any personal information.

BYOK — You can provide your own AI provider API keys where supported. Direct provider calls may bypass our managed model relay, but conversation and task content is still stored by Stella as described above.


17. Children's Privacy

Stella is not directed to children under 13 years of age. We do not knowingly collect personal information from children under 13. If you believe we have inadvertently collected such information, please contact us and we will promptly delete it.


18. International Users

Our backend infrastructure is hosted in the United States. If you access the Service from outside the United States, your information may be transferred to and processed in the United States.


19. California Privacy Rights

If you are a California resident, you may have additional rights under the California Consumer Privacy Act (CCPA). Personal information we process may include conversation, task, account, billing, device, usage, delivery, and connected-service data. You may exercise your rights to know, delete, or opt out by contacting us. We do not sell your personal information. We do not use your data for targeted advertising.


20. European Privacy Rights

If you are in the European Economic Area (EEA) or United Kingdom, you may have rights under the GDPR including the right to access, rectify, erase, restrict processing, data portability, and objection. These rights apply to personal data we process, which may include conversation, task, account, billing, device, usage, delivery, and connected-service data. Contact us to exercise these rights. Where we process personal data, we rely as applicable on: (a) contractual necessity; (b) legitimate interests such as security and abuse prevention; and (c) consent for optional features.


21. Changes to This Policy

We may update this Privacy Policy from time to time. We will indicate the date of the most recent revision at the top. For material changes, we will make reasonable efforts to notify you. Your continued use of the Service after changes constitutes acceptance of the updated policy.


22. Contact Us

If you have questions about this Privacy Policy or wish to exercise any of your rights, contact us at:

FromYou LLC
131 Continental Drive, Suite 305
Newark, DE 19713

Email: contact@fromyou.ai`;
