import { DOMAINS, type AnyContentDomain, type DomainConfig } from './domains';
import { REG_DOMAINS } from './regDomains';
import { OVERVIEW_DOMAIN } from './overviewDomain';
import type { AnyDomain } from '@/types/entity';

const ALL: Record<string, DomainConfig> = { overview: OVERVIEW_DOMAIN, ...DOMAINS, ...REG_DOMAINS };

/** Resolve a domain config for a Company Brain OR Regulatory Brain domain. */
export function getDomainConfig(id: string | undefined): DomainConfig | undefined {
  return id ? ALL[id] : undefined;
}

export function isRegDomain(id: AnyDomain | string | undefined): boolean {
  return typeof id === 'string' && id.startsWith('reg-');
}

export function domainNoun(id: AnyContentDomain): string {
  return ALL[id]?.entityNoun ?? 'Entity';
}
