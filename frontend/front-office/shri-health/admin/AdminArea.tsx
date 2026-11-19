// SHRI_HEALTH: the front office's Administration area (section 8 of Sena's demo plan; Vimal on #85,
// 18 Nov): read-only screens for the administrator on Thulasi's admin API (#402), each shown only
// with its read permission. It is the shared admin area: the password-reset approvals (Minalini)
// join it as another section. Front office styling only.
import { ShieldCheck } from 'lucide-react'
import type { ComponentType } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'

import { PageHeader } from '../../src/components/layout/PageHeader'
import { Card, CardBody } from '../../src/components/ui/Card'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { cn } from '../../src/utils/cn'
import { sectionsFor, useAdminAccess, type AdminSection } from './access'
import { AuditTrailPage } from './AuditTrailPage'
import { FhirRecordPage } from './FhirRecordPage'
import { IntegrationsPage } from './IntegrationsPage'
import { PasswordResetsPage } from './PasswordResetsPage'
import { UsersRolesPage } from './UsersRolesPage'

const PAGES: Record<AdminSection['path'], ComponentType> = {
  users: UsersRolesPage,
  audit: AuditTrailPage,
  fhir: FhirRecordPage,
  integrations: IntegrationsPage,
  'password-resets': PasswordResetsPage,
}

function AdminTabs({ sections }: { sections: AdminSection[] }) {
  return (
    <nav aria-label="Administration" className="scrollbar-hide flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border-soft">
      {sections.map((s) => (
        <NavLink
          key={s.path}
          to={`/admin/${s.path}`}
          className={({ isActive }) =>
            cn(
              'focus-ring -mb-px inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-t-lg border-b-2 px-3 text-sm font-medium transition-colors',
              isActive ? 'border-primary-600 text-primary-text' : 'border-transparent text-ink-subtle hover:text-ink',
            )
          }
        >
          {s.label}
        </NavLink>
      ))}
    </nav>
  )
}

function NoAccess() {
  return (
    <Card>
      <CardBody>
        <EmptyState icon={ShieldCheck} title="Administration is for the clinic's administrator" description="Your account doesn't include the administration screens." />
      </CardBody>
    </Card>
  )
}

export function AdminArea() {
  const { isAdmin, permissions } = useAdminAccess()
  const sections = permissions ? sectionsFor(permissions) : []
  return (
    <div>
      <PageHeader
        title="Administration"
        subtitle={
          sections.some((s) => s.path === 'password-resets')
            ? "Users and roles, the audit trail, a patient's FHIR record and partner messages (read only), and password reset approvals."
            : "Read only: users and roles, the audit trail, a patient's FHIR record and partner messages."
        }
        tabs={isAdmin && sections.length > 0 ? <AdminTabs sections={sections} /> : undefined} />
      <div className="mt-4 sm:mt-5">
        {!isAdmin ? (
          <NoAccess />
        ) : permissions === null ? (
          <p className="text-sm text-ink-muted" role="status">
            Opening administration…
          </p>
        ) : sections.length === 0 ? (
          <NoAccess />
        ) : (
          <Routes>
            <Route index element={<Navigate to={sections[0]!.path} replace />} />
            {sections.map((s) => {
              const Page = PAGES[s.path]
              return <Route key={s.path} path={`${s.path}/*`} element={<Page />} />
            })}
            <Route path="*" element={<NoAccess />} />
          </Routes>
        )}
      </div>
    </div>
  )
}
