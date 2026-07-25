import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { rememberControlPlaneToken, verifyControlPlaneToken } from "@/lib/api"

/**
 * The sign-in state. The shell is served without a token (see `apps/cli/src/control-plane.ts`), so
 * this is what an unauthenticated visitor sees, and what a `401` from any screen returns them to.
 *
 * The token is checked against `GET /api/status` before it is stored: a token that does not work
 * must not be remembered, or every screen renders a failure instead of this form.
 */
export function SignIn() {
  const [token, setToken] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setChecking(true)
    setError(null)
    try {
      if (await verifyControlPlaneToken(token.trim()))
        return rememberControlPlaneToken(token.trim())
      setError("The control plane refused that token.")
    } catch {
      setError("The control plane could not be reached.")
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>ambient-agent</CardTitle>
          <CardDescription>
            Paste the control-plane bearer token. It is in{" "}
            <code>credentials/control-plane.json</code> inside the managed data
            directory, and the CLI prints its path on start.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Field data-invalid={error !== null || undefined}>
              <FieldLabel htmlFor="control-plane-token">
                Bearer token
              </FieldLabel>
              <Input
                id="control-plane-token"
                type="password"
                autoComplete="off"
                autoFocus
                value={token}
                onChange={(event) => setToken(event.target.value)}
                aria-invalid={error !== null || undefined}
              />
              {error !== null && <FieldError>{error}</FieldError>}
            </Field>
            <Button type="submit" disabled={checking || token.trim() === ""}>
              {checking ? "Checking…" : "Continue"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
