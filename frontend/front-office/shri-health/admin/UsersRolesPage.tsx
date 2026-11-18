// SHRI_HEALTH: Users and roles, read only (listRoles, listUsers; roles:read, users:read; #402).
import { KeyRound, Users } from 'lucide-react'
import { useEffect, useState } from 'react'

import { listRoles, listUsers } from '../../../src/api/generated/endpoints/platform/platform'
import type { Role, User } from '../../../src/api/generated/model'
import { Alert } from '../../src/components/ui/Alert'
import { Badge } from '../../src/components/ui/Badge'
import { Card, CardBody, CardHeader } from '../../src/components/ui/Card'
import { ResponsiveTable, type Column } from '../../src/components/ui/ResponsiveTable'
import { readFailure, when } from './format'

type Loaded<T> = { items: T[] } | { error: string } | null

async function allPages<T>(read: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | null }>): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const res = await read(cursor)
    items.push(...res.items)
    if (!res.nextCursor) break
    cursor = res.nextCursor
  }
  return items
}

const ROLE_COLUMNS: Column<Role>[] = [
  { key: 'name', header: 'Role', cell: (r) => <span className="font-medium text-ink">{r.name}</span>, sortValue: (r) => r.name },
  { key: 'code', header: 'Code', cell: (r) => <span className="tabular-nums">{r.code}</span> },
  { key: 'users', header: 'Users', numeric: true, cell: (r) => r.userCount, sortValue: (r) => r.userCount },
  {
    key: 'permissions',
    header: 'Permissions',
    cell: (r) => (
      <details>
        <summary className="cursor-pointer text-sm text-primary-text">{r.permissions.length} permissions</summary>
        <ul className="mt-2 columns-1 gap-4 text-xs text-ink-muted sm:columns-2">
          {r.permissions.map((p) => (
            <li key={p} className="break-all">
              {p}
            </li>
          ))}
        </ul>
      </details>
    ),
  },
]

const USER_COLUMNS: Column<User>[] = [
  { key: 'name', header: 'Name', cell: (u) => <span className="font-medium text-ink">{u.displayName}</span>, sortValue: (u) => u.displayName },
  { key: 'username', header: 'Username', cell: (u) => u.username, sortValue: (u) => u.username },
  { key: 'roles', header: 'Roles', cell: (u) => u.roles.join(', ') },
  { key: 'active', header: 'Status', cell: (u) => <Badge tone={u.active ? 'stable' : 'neutral'}>{u.active ? 'Active' : 'Disabled'}</Badge> },
  { key: 'last', header: 'Last sign-in', cell: (u) => when(u.lastSignInAt), sortValue: (u) => u.lastSignInAt ?? '' },
]

export function UsersRolesPage() {
  const [roles, setRoles] = useState<Loaded<Role>>(null)
  const [users, setUsers] = useState<Loaded<User>>(null)

  useEffect(() => {
    let live = true
    allPages(async (cursor) => {
      const res = await listRoles({ limit: 100, ...(cursor ? { cursor } : {}) })
      return res.status === 200 ? res.data : { items: [] }
    }).then(
      (items) => live && setRoles({ items }),
      (err: unknown) => live && setRoles({ error: readFailure(err, 'the roles') }),
    )
    allPages(async (cursor) => {
      const res = await listUsers({ limit: 100, ...(cursor ? { cursor } : {}) })
      return res.status === 200 ? res.data : { items: [] }
    }).then(
      (items) => live && setUsers({ items }),
      (err: unknown) => live && setUsers({ error: readFailure(err, 'the users') }),
    )
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card>
        <CardHeader icon={KeyRound} title="Roles" subtitle="Each staff role and what it may do. Changes are made in Keycloak by the administrator." />
        <CardBody>
          {roles === null ? <p role="status" className="text-sm text-ink-muted">Reading the roles…</p> : 'error' in roles ? <Alert tone="critical" title={roles.error} /> : <ResponsiveTable rows={roles.items} columns={ROLE_COLUMNS} rowKey={(r) => r.code} caption="Roles" />}
        </CardBody>
      </Card>
      <Card>
        <CardHeader icon={Users} title="Users" subtitle="The clinic's staff accounts." />
        <CardBody>
          {users === null ? <p role="status" className="text-sm text-ink-muted">Reading the users…</p> : 'error' in users ? <Alert tone="critical" title={users.error} /> : <ResponsiveTable rows={users.items} columns={USER_COLUMNS} rowKey={(u) => u.id} caption="Users" showFooter />}
        </CardBody>
      </Card>
    </div>
  )
}
