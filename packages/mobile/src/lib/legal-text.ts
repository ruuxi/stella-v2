/**
 * Legal text for the mobile app.
 *
 * Source of truth: ../stella-website/src/lib/legal-text.ts
 * Desktop copy: desktop/src/global/legal/legal-text.ts
 *
 * When updating, keep all three in sync.
 */

export type LegalDocument = "terms" | "privacy";

export const LEGAL_TITLES: Record<LegalDocument, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
};

export const LEGAL_LAST_UPDATED = "August 26, 2026";

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

The Stella Platform (Free) — Stella is a personal AI assistant with desktop, mobile, and hosted components. The platform is completely free and open source. The Electron desktop application can run tool execution and computer use on your device and keep local execution data and a rebuildable cache. The mobile app and supported desktop experiences use Stella's hosted conversation services.

The Stella Provider (Paid LLM Service) — Separately, FromYou operates the Stella Provider, a managed LLM inference service that routes AI model requests to upstream providers on your behalf. The Stella Provider is the paid component of the Service — subscription plans and usage-based billing apply to LLM inference consumed through the Stella Provider. You are never required to use the Stella Provider; you may supply your own API keys (BYOK) and use the platform entirely for free.

Additional Backend Services — Our backend also provides authentication, cloud-authoritative conversations and memory, cloud agent execution, Stella mobile app connectivity, connected integrations, the mod store, social features, and media generation capabilities.


5. Cloud and Local Data

Cloud-Authoritative Service Data — Stella's hosted services maintain the authoritative copy of conversations, chat history, event transcripts, tool outputs, activity records, and saved memory. This service data is encrypted in transit and at rest. Supported clients may keep a rebuildable local cache for display and local execution. Deleting a local cache does not by itself delete the cloud-authoritative copy.

Local Execution Data — Files on your device, locally captured screenshots, locally stored credentials and settings, and other device execution data can remain local. Data needed for a requested hosted feature, AI inference, cloud agent task, or connected integration may be sent to and processed by Stella services and the applicable third party. A task's relevant inputs and results may also become part of the cloud-authoritative conversation, tool, activity, or memory record.

Provider and Integration Processing — Prompts, attachments, relevant conversation context, tool inputs and results, and data you direct Stella to use may be processed by Stella's infrastructure, selected AI providers, and connected integrations as needed to provide the requested feature. Those third parties process data under their own terms and privacy policies.

Discovery Signals — During onboarding, Stella may optionally process signals from your device (browser bookmarks, installed applications, development environment, etc.) to personalize your experience. Raw discovery signals are processed locally unless you choose a feature that imports resulting memory or selected data into Stella's hosted services. Discovery categories involving sensitive data (messages, notes) are opt-in and disabled by default.

Stella Mobile App — The mobile app reads and writes the same cloud-authoritative conversation history available to supported Stella clients. When a task executes on your desktop, Stella also uses device and routing metadata to deliver work and synchronize the resulting conversation and activity records.


6. Computer Use and Agent Autonomy

What Stella Can Do on Your Computer — Stella's AI agents can perform actions on your computer on your behalf, including but not limited to: reading, writing, editing, and deleting files and directories; executing shell commands and running scripts; browsing the web, clicking links, filling forms, and navigating websites; capturing screenshots and reading on-screen content; opening applications and interacting with your operating system; modifying Stella's own user interface and code; scheduling automated tasks that run in the background; and interacting with connected services and APIs.

Your Responsibility — You are solely and entirely responsible for all actions that Stella's AI agents perform on your computer and accounts. Stella acts as a tool under your direction. When you instruct Stella to perform a task, you authorize it to take the actions necessary to complete that task, including any intermediate steps the AI determines are needed.

You acknowledge and agree that: AI agents may take actions that produce unintended, incorrect, or irreversible results, including data loss, file deletion, unintended purchases, unauthorized access to services, or system damage. It is your responsibility to review, supervise, and verify the actions taken by AI agents. You should not grant Stella access to systems or accounts where unintended actions could cause harm you are unwilling to accept. FromYou does not control, review, or approve the specific actions an AI agent takes in response to your instructions. The AI's behavior is determined by the underlying language model, your prompts, your system configuration, and the tools available. FromYou is not liable for any loss, damage, cost, or consequence resulting from actions performed by Stella's AI agents on your device, accounts, or connected services, regardless of whether those actions were intended, expected, or authorized by you.

Safety Mechanisms — Stella includes certain safety mechanisms (e.g., command safety checks, network guards, security policies, confirmation prompts for sensitive operations). These mechanisms are provided as a convenience and are not guaranteed to prevent all harmful actions. You should not rely on them as a substitute for your own judgment and supervision.


7. AI Services and the Stella Provider

Managed LLM Inference (Stella Provider) — The Stella Provider is a managed LLM inference service. When you do not supply your own API keys, Stella routes AI model requests through our backend to named third parties that provide AI infrastructure and model access. Depending on the model and routing path, this can include OpenRouter or Fireworks as managed AI gateways, and upstream AI model providers such as DeepSeek, Anthropic, OpenAI, and Google. Requests made through a provider's Responses API may enable provider-side response storage for stateful continuation. Prompts and responses pass through our infrastructure in transit and may be retained by the selected provider under its own policies. The Stella Provider is the only paid component of the Service.

Bring Your Own Keys (BYOK) — You may configure your own API keys for supported AI providers (Anthropic, OpenAI, Google, etc.). Supported BYOK routes send the model request directly from your device to the provider, without using the Stella Provider for that model call. Your API keys are stored locally on your device in encrypted form. The cloud-authoritative conversation record remains in Stella's hosted services. Using BYOK means you can use Stella entirely for free.

Third-Party AI Providers — Whether using the Stella Provider or BYOK, your prompts and other model inputs you choose to send, including text, images, and related model context, are processed by third-party AI services. These providers have their own terms of service and privacy policies. We do not control how third-party providers handle your data once it reaches their systems. FromYou is not responsible for the outputs, accuracy, or behavior of any third-party AI model.

Media Generation — Stella may offer media generation features (image, audio, video) through third-party providers. Media generation requests are processed by those providers and subject to their terms.


8. Subscription Plans and Billing

Free Use — The Stella platform is free to use. You can use all features of the desktop and mobile application at no cost by providing your own API keys (BYOK).

Stella Provider Plans — The Stella Provider LLM inference service offers a free tier with rate-limited access, as well as paid subscription plans (currently Go and Pro) with higher usage limits and access to additional AI models. Paid plans are billed monthly through Stripe.

Pricing Changes — All prices are subject to change at any time, including during the beta period. We will make reasonable efforts to notify active subscribers of pricing changes in advance. Continued use of a paid plan after a price change constitutes acceptance of the new pricing.

Usage Limits — Each plan includes usage allowances measured in token consumption. If you exceed your plan's limits, service may be temporarily throttled until the next billing period.

Cancellation — You may cancel your subscription at any time. Cancellation takes effect at the end of the current billing period. No refunds are provided for partial billing periods.


9. Self-Modifying Capabilities

Stella's AI agents can modify the application's own user interface and functionality when instructed by you. These modifications are made locally via Vite hot-module replacement and are tracked in a local Git repository on your device. You may revert any self-modification at any time. You are responsible for reviewing and accepting changes made by the AI to your local Stella installation.


10. Mod Store

Publishing — You may publish modifications ("mods") to the Stella Mod Store. By publishing, you grant FromYou and other Stella users a non-exclusive, worldwide, royalty-free license to use, install, and distribute your mod through the Service.

Installing — Mods are community-created and are not reviewed or endorsed by FromYou. You install mods at your own risk. We are not responsible for any damage, data loss, or security issues caused by third-party mods.

Prohibited Content — You may not publish mods that contain malware, violate any law, infringe third-party rights, or are designed to harm users or their systems.


11. Open-Source Software

Stella's platform is open source. Your use of the open-source code is governed by the applicable open-source license(s) in the repository. These Terms govern your use of the hosted Service (backend APIs, Stella Provider, Mod Store, etc.) which may include components, infrastructure, and services not covered by the open-source license.


12. Acceptable Use

You agree not to: use the Service for any unlawful purpose or to violate any applicable law or regulation; attempt to gain unauthorized access to any part of the Service or its related systems; interfere with or disrupt the Service, servers, or networks connected to the Service; use the Service to generate content that is illegal, harmful, threatening, abusive, harassing, defamatory, or otherwise objectionable; circumvent any rate limits, usage restrictions, or access controls; reverse-engineer, decompile, or disassemble any proprietary component of the Service (this does not restrict your rights under the applicable open-source license for open-source components); use the Service to build a competing product or service by systematically extracting data from our backend APIs; or resell access to the Stella Provider or backend services without our written permission.


13. Intellectual Property

Our Rights — The Stella name, logo, and branding are the property of FromYou LLC. The hosted backend services, API infrastructure, and any proprietary components not released under an open-source license remain the intellectual property of FromYou.

Your Rights — You retain all rights to your data, conversations, and any content you create using the Service. You retain all rights to mods you create, subject to the license granted in section 10.

Open Source — Open-source components of Stella are licensed under their respective open-source licenses.


14. Disclaimer of Warranties

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. FROMYOU DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE. THE SERVICE IS IN BETA AND MAY CONTAIN BUGS, ERRORS, AND INCOMPLETE FEATURES.

AI-GENERATED CONTENT MAY BE INACCURATE, INCOMPLETE, OR INAPPROPRIATE. YOU ARE SOLELY RESPONSIBLE FOR EVALUATING AND USING AI-GENERATED OUTPUT. FROMYOU IS NOT LIABLE FOR ANY ACTIONS TAKEN BASED ON AI-GENERATED CONTENT OR ANY ACTIONS PERFORMED BY STELLA'S AI AGENTS ON YOUR COMPUTER, ACCOUNTS, OR CONNECTED SERVICES, INCLUDING BUT NOT LIMITED TO CODE EXECUTION, FILE CREATION OR DELETION, SHELL COMMANDS, WEB BROWSING, FORM SUBMISSIONS, PURCHASES, DATA TRANSMISSION, OR ANY OTHER OPERATION THE AGENT PERFORMS. YOU USE STELLA'S COMPUTER-USE CAPABILITIES ENTIRELY AT YOUR OWN RISK.


15. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, FROMYOU SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, LOSS OF PROFITS, DAMAGE TO YOUR DEVICE OR SYSTEMS, UNAUTHORIZED ACCESS TO YOUR ACCOUNTS, UNINTENDED PURCHASES OR TRANSACTIONS, OR ANY OTHER HARM ARISING FROM ACTIONS PERFORMED BY STELLA'S AI AGENTS, REGARDLESS OF THE THEORY OF LIABILITY.

WITHOUT LIMITING THE FOREGOING, FROMYOU SHALL NOT BE LIABLE FOR ANY DAMAGES ARISING FROM: (A) ACTIONS TAKEN BY AI AGENTS ON YOUR COMPUTER OR ACCOUNTS; (B) INACCURATE, INCOMPLETE, OR HARMFUL AI-GENERATED OUTPUT; (C) MODS OR EXTENSIONS CREATED BY THIRD PARTIES; (D) INTERRUPTIONS OR ERRORS IN THE STELLA PROVIDER INFERENCE SERVICE; OR (E) THE ACTS OR OMISSIONS OF THIRD-PARTY AI MODEL PROVIDERS.

OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID TO FROMYOU FOR THE STELLA PROVIDER IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR (B) FIFTY DOLLARS ($50).


16. Indemnification

You agree to indemnify and hold harmless FromYou, its officers, directors, employees, and agents from any claims, liabilities, damages, losses, or expenses (including reasonable attorneys' fees) arising out of or related to: (a) your use of the Service, including any actions taken by AI agents on your behalf; (b) your violation of these Terms; (c) mods you publish to the Mod Store; (d) your violation of any third-party rights; or (e) any consequences of computer-use actions performed by Stella on your device, accounts, or connected services.


17. Third-Party Services

The Service integrates with third-party services including AI model providers, Stripe for payments, and fal.ai for media generation. Your use of these services is subject to their respective terms. We are not responsible for the availability, accuracy, or practices of any third-party service.


18. Termination

We may suspend or terminate your access to the Service at any time, with or without cause, with or without notice. You may stop using the Service at any time. Upon termination, your right to use the hosted backend services ceases, but your locally stored data remains on your device under your control.


19. Governing Law and Dispute Resolution

These Terms are governed by the laws of the State of Delaware, without regard to its conflict-of-law provisions. Any dispute arising under these Terms shall be resolved in the state or federal courts located in Delaware, and you consent to personal jurisdiction in those courts.


20. Changes to These Terms

We may update these Terms from time to time. We will indicate the date of the most recent revision at the top of this page. Your continued use of the Service after any changes constitutes acceptance of the updated Terms. For material changes, we will make reasonable efforts to notify you (e.g., through the application or by email if you have an account).


21. Severability

If any provision of these Terms is found to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.


22. Entire Agreement

These Terms, together with our Privacy Policy, constitute the entire agreement between you and FromYou regarding the Service and supersede any prior agreements.


23. Contact Us

If you have questions about these Terms, contact us at:

FromYou LLC
131 Continental Drive, Suite 305
Newark, DE 19713

Email: contact@fromyou.ai`;

export const PRIVACY_POLICY = `Stella — FromYou LLC
Last updated: ${LEGAL_LAST_UPDATED}

This Privacy Policy describes how FromYou LLC ("FromYou," "we," "us," or "our") handles information when you use Stella, including the desktop application, mobile companion app, backend services, and related websites or APIs (collectively, the "Service").

Stella maintains cloud-authoritative conversation and memory records while supported clients may keep rebuildable local caches and device execution data. Requested features may also send data to AI providers and connected integrations. Stella's platform is open source. This policy explains what is stored by Stella's services, what can remain on your device, and when third parties process data.


1. Cloud and Local Data Flows

Stella combines local execution with hosted services:

• Stella's hosted services maintain the authoritative copy of conversations, event transcripts, tool outputs, activity records, and saved memory. That service data is encrypted in transit and at rest.
• The desktop app may keep a rebuildable SQLite cache and device-local execution data. Removing that cache does not delete the cloud-authoritative copy.
• No account is required. You can use Stella anonymously without providing any personal information.
• The platform is open source. You can inspect exactly how your data is handled.


2. Device Data Not Uploaded by Default

Stella does not upload device data merely because it exists on your computer. Unless you attach it, direct Stella to use it, enable a feature that needs it, or it becomes part of a cloud conversation or memory record, the following can remain local:

• Files on your computer or files created, modified, or deleted by Stella's AI agents
• Screenshots, screen captures, or on-screen content read by the agent
• Websites visited, forms filled, or actions taken by Stella's browser-use capabilities
• Browser history, bookmarks, or browsing data (yours or the agent's)
• Contents of your messages, notes, or calendar
• Shell commands executed by the agent or their output
• Voice recordings or transcripts
• Raw data discovered during onboarding personalization
• Your locally stored API keys

Relevant content from these categories may be sent to Stella's hosted services, an AI provider, or a connected integration when needed to perform a task you request. Cloud-authoritative conversation, transcript, tool, activity, and memory records are described below.


3. Information Stored on Your Device

Depending on the client and features you use, Stella may store the following on your device:

• A rebuildable SQLite cache of cloud conversation, transcript, tool, activity, and file projections
• Device execution state and local working data used while a task runs on that device
• Files, screenshots, and command output that are not included in a hosted task or record
• Discovery signals — optional onboarding personalization data (browser bookmarks, apps, dev environment, etc.)
• LLM API keys (encrypted) — your own provider credentials for BYOK use
• Local preferences and settings — theme, model preferences, configuration
• Self-modification history (Git) — tracking of AI-made UI changes for undo/revert
• Installed mods and skills — extensions you have installed
• Device identity keypair — cryptographic identity for your device

You can delete device-local data by removing the Stella data directory or using applicable in-app controls. Clearing a device cache does not necessarily delete cloud-authoritative data; use the Service's data or account deletion controls for hosted copies.


4. Information Stored or Processed by Hosted Services

Cloud Conversations and Memory — Stella stores the authoritative conversation history, event transcripts, tool outputs, activity records, and saved memory for an owner in its hosted services. This data is encrypted in transit and at rest and is used to synchronize supported clients, recover from local cache loss, and provide requested cloud features.

Stella Provider (Managed LLM Inference) — The Stella Provider is our managed LLM inference service, the only paid component of Stella. When you use it, your prompt, attachments, relevant conversation context, and the AI response pass through our backend and the selected third-party AI infrastructure. Requests made through a provider's Responses API may enable provider-side response storage for stateful continuation. The selected provider may retain request and response records under its own retention and deletion policies.

The Stella Provider forwards model response bytes as they arrive. Conversation events and model or tool results accepted into Stella's cloud journal become part of the cloud-authoritative record; upstream providers may separately store or retain request and response data under their own policies.

We separately log usage metadata for billing, security, and rate limiting, such as timestamp, model, token count, duration, success or failure, safe upstream request identifiers, and an owner or anonymous device identifier. We do not put prompt or response bodies in those diagnostics. Supported BYOK routes may send model requests directly to the provider, which remains subject to that provider's policies.

Cloud Agent and Mobile Processing — Messages submitted from supported clients and cloud agent work are processed by Stella's hosted services. Accepted messages, responses, event transcripts, tool outputs, and activity records are written to the cloud-authoritative conversation history.

Device Routing — When Stella dispatches or synchronizes work with a desktop, we process device identifiers, conversation mappings, connectivity state, and delivery metadata needed to route that work.

Connected Integrations — When you connect or direct Stella to use another service, the task inputs, selected content, credentials or authorization tokens, and results needed for that action may be processed by Stella's integration infrastructure and the connected service. The connected service's own terms and privacy policy apply.


5. Computer Use and Agent Activity Data

Stella's AI agents can perform actions on your computer, including browsing the web, executing commands, reading and writing files, and interacting with applications. The underlying action can occur locally, while relevant instructions, context, status, and results may be included in the cloud-authoritative conversation or sent to a selected provider or integration. In general:

• Files the agent creates, reads, modifies, or deletes remain on your local filesystem unless you ask Stella to upload, share, or process them through a hosted feature or integration.
• Shell commands execute on the selected device, but relevant commands, output, and status can appear in the cloud conversation and activity record.
• Screenshots and screen content stay on your device unless they are needed as task context or you direct Stella to send or store them.
• Browser and integration data may be processed by the applicable service when the task requires it.

When an agent action requires AI inference, relevant task context is sent through the configured model route. Managed routes pass through Stella infrastructure and the selected provider; supported BYOK routes may send the model request directly to the provider. The cloud-authoritative Stella record and the provider's own processing are separate, and provider or integration retention is governed by that third party's policies.


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


10. Social Features

If you use Stella's social features (friend system, chat rooms, collaborative sessions), the following is stored on our backend: social profile (nickname, friend code), friend relationships, chat room membership and messages, and collaborative session metadata and file operations. Social features are opt-in and require a signed-in account.


11. Mod Store

If you publish a mod to the Stella Mod Store, we store the mod package, metadata (name, description, author), and release artifacts. Published mods are publicly visible to other Stella users.


12. Third-Party Services

Stella integrates with third-party services. When your data reaches these services, it is subject to their respective privacy policies. This includes AI gateways and model providers (OpenRouter, Fireworks, DeepSeek, Anthropic, OpenAI, and Google) when processing AI requests, Stripe when subscribing to a paid plan, fal.ai when using media generation features, Convex for backend infrastructure, and services you connect through Stella integrations. Supported BYOK model requests may go directly from your device to the provider without using the Stella Provider; the cloud-authoritative conversation record remains in Stella's hosted services.


13. Data Retention

Retention depends on the data category, the feature used, legal requirements, available deletion controls, and any third-party provider or integration policy. This policy does not promise a fixed retention period except where one is expressly stated.

• Device-local data — remains on the device until removed by you or the operating system; portions you send to a hosted feature may also exist in the cloud-authoritative record
• Cloud conversation and memory data — stored to provide conversation history, synchronization, recovery, memory, and cloud agent features, subject to applicable data and account deletion controls
• Account information — until you delete your account
• Billing records — as required by law and for dispute resolution (typically 7 years for financial records)
• Usage metadata — rolling windows (5-hour, weekly, monthly); aggregates retained for billing reconciliation
• Connector and integration data — retention depends on Stella's service operation and the connected provider's policies
• Anonymous device usage — retained for service operation, security, and rate limiting
• Social data — until you delete your account or the relevant content


14. Data Security

We implement reasonable security measures to protect data processed by Stella: cloud-authoritative conversation and memory data is encrypted in transit and at rest; user-provided secrets stored on our backend are encrypted using AES-256-GCM with a versioned master key system; API keys stored on your device are encrypted locally; devices authenticate using Ed25519 cryptographic keypairs; and multi-layer rate limiting protects against abuse. No security measure eliminates all risk, and third-party providers and integrations apply their own security practices.


15. Your Rights and Choices

Access and Control — You can manage device-local data through Stella's data directory and applicable in-app controls. Cloud conversation, memory, account, and other hosted data must be managed through the Service's data, reset, integration-revocation, or account-deletion controls where available. Clearing a local cache alone does not delete the cloud-authoritative copy.

Discovery Opt-Out — During onboarding, each discovery category is individually selectable. The most sensitive category (Messages & Notes) is disabled by default and requires explicit opt-in. You can skip discovery entirely.

Anonymous Use — You can use Stella's core features without creating an account or providing any personal information.

BYOK — You can provide your own AI provider API keys for supported direct model routes. This avoids the Stella Provider for those model calls, but does not remove the cloud-authoritative conversation record from Stella's hosted services.


16. Children's Privacy

Stella is not directed to children under 13 years of age. We do not knowingly collect personal information from children under 13. If you believe we have inadvertently collected such information, please contact us and we will promptly delete it.


17. International Users

Our backend infrastructure is hosted in the United States. If you access the Service from outside the United States, your information (to the extent it reaches our servers, as described in this policy) may be transferred to and processed in the United States.


18. California Privacy Rights

If you are a California resident, you may have additional rights under the California Consumer Privacy Act (CCPA), including rights concerning cloud conversation, memory, account, billing, device, and other personal information we process. You may exercise your rights to know, delete, or opt out by contacting us. We do not sell your personal information. We do not use your data for targeted advertising.


19. European Privacy Rights

If you are in the European Economic Area (EEA) or United Kingdom, you may have rights under the GDPR including the right to access, rectify, erase, restrict processing, data portability, and objection. These rights can apply to cloud conversation, memory, account, billing, device, and other personal data we process. Contact us to exercise these rights. Where we process personal data, we rely on applicable legal bases, which may include contractual necessity, legitimate interests such as security and abuse prevention, and consent for optional features.


20. Changes to This Policy

We may update this Privacy Policy from time to time. We will indicate the date of the most recent revision at the top. For material changes, we will make reasonable efforts to notify you. Your continued use of the Service after changes constitutes acceptance of the updated policy.


21. Open Source Transparency

Stella's platform is open source, and its source code can be reviewed.


22. Contact Us

If you have questions about this Privacy Policy or wish to exercise any of your rights, contact us at:

FromYou LLC
131 Continental Drive, Suite 305
Newark, DE 19713

Email: contact@fromyou.ai`;
