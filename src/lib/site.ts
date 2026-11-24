// PTO Info Daily — site-wide details used by the policy and error pages.
// Change contact details here once and every page updates.

export const SITE = {
  name: "PTO Info Daily",
  url: "https://ptoinfodaily.com",
  tagline: "Real stories. Nigeria. Daily.",
  location: "Lagos, Nigeria",

  // Readers use this address for corrections, complaints, privacy requests
  // and general editorial enquiries. It MUST be a mailbox someone reads.
  editorialEmail: "ptoinfodaily@gmail.com",

  // Shown as "Last updated" on the Our Standards pages.
  policiesUpdated: "4 November 2026",
} as const;

export const STANDARDS_PAGES = [
  { href: "/editorial-policy/", label: "Editorial Policy" },
  { href: "/corrections-policy/", label: "Corrections Policy" },
  { href: "/privacy/", label: "Privacy Policy" },
  { href: "/terms/", label: "Terms of Use" },
] as const;
