import React, { useState, useEffect, useCallback } from 'react'

export default function App() {
  // --------------------------------------------------------------------------
  // Authentication State
  // --------------------------------------------------------------------------
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem('ksc_discount_token') || '')
  const [currentUser, setCurrentUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)

  // Login Form State
  const [loginEmail, setLoginEmail] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [authMsg, setAuthMsg] = useState({ type: '', text: '' })
  const [requestingCode, setRequestingCode] = useState(false)
  const [verifyingCode, setVerifyingCode] = useState(false)

  // --------------------------------------------------------------------------
  // Dashboard Data State
  // --------------------------------------------------------------------------
  const [dataLoading, setDataLoading] = useState(false)
  const [settings, setSettings] = useState({
    employee_discount_percent: 20,
    monthly_store_credit_amount: 25.0,
  })
  const [savingSettings, setSavingSettings] = useState(false)
  const [employees, setEmployees] = useState([])
  const [recentLogs, setRecentLogs] = useState([])
  const [searchQuery, setSearchQuery] = useState('')

  // Quick Action: Onboard Employee State (Step 1 & Step 2)
  const [onboardName, setOnboardName] = useState('')
  const [onboardEmail, setOnboardEmail] = useState('')
  const [onboardDiscount, setOnboardDiscount] = useState('20')
  const [onboardCredit, setOnboardCredit] = useState('25.00')
  const [onboardLocation, setOnboardLocation] = useState('local')
  const [lastCreatedAlert, setLastCreatedAlert] = useState(null)
  const [onboarding, setOnboarding] = useState(false)

  // Quick Action: Monthly Credit Run State
  const [runningMonthlyCredit, setRunningMonthlyCredit] = useState(false)

  // Single Credit Modal State
  const [creditModalOpen, setCreditModalOpen] = useState(false)
  const [selectedEmployee, setSelectedEmployee] = useState(null)
  const [creditAmount, setCreditAmount] = useState('25.00')
  const [creditReason, setCreditReason] = useState('Manual Employee Store Credit')
  const [issuingCredit, setIssuingCredit] = useState(false)

  // Toast State
  const [toast, setToast] = useState(null)

  const showToast = (message, type = 'info') => {
    setToast({ message, type })
    setTimeout(() => {
      setToast(null)
    }, 4500)
  }

  // Helper for API calls with Bearer token
  const apiFetch = useCallback(
    async (url, options = {}) => {
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      }
      if (sessionToken) {
        headers['Authorization'] = `Bearer ${sessionToken}`
      }
      const res = await fetch(url, { ...options, headers })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      return data
    },
    [sessionToken]
  )

  // --------------------------------------------------------------------------
  // Verify Existing Session on Mount
  // --------------------------------------------------------------------------
  useEffect(() => {
    async function verifySession() {
      if (!sessionToken) {
        setAuthLoading(false)
        return
      }
      try {
        const res = await fetch('/api/auth?route=session', {
          headers: { Authorization: `Bearer ${sessionToken}` },
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.ok) {
          setCurrentUser(data.user)
        } else {
          localStorage.removeItem('ksc_discount_token')
          setSessionToken('')
          setCurrentUser(null)
        }
      } catch {
        localStorage.removeItem('ksc_discount_token')
        setSessionToken('')
        setCurrentUser(null)
      } finally {
        setAuthLoading(false)
      }
    }
    verifySession()
  }, [sessionToken])

  // --------------------------------------------------------------------------
  // Fetch Dashboard Data (Settings, Employees, Recent Logs)
  // --------------------------------------------------------------------------
  const loadDashboardData = useCallback(async () => {
    if (!sessionToken) return
    setDataLoading(true)
    try {
      const [dataRes, empRes] = await Promise.all([
        apiFetch('/api/discounts?route=data').catch(() => ({})),
        apiFetch('/api/employees').catch(() => ({})),
      ])

      if (dataRes.settings) {
        setSettings({
          employee_discount_percent: dataRes.settings.employee_discount_percent ?? 20,
          monthly_store_credit_amount: dataRes.settings.monthly_store_credit_amount ?? 25.0,
        })
        setOnboardDiscount(String(dataRes.settings.employee_discount_percent ?? 20))
        setOnboardCredit(String(dataRes.settings.monthly_store_credit_amount ?? 25.0))
      }
      setRecentLogs(dataRes.recentLogs || [])

      // Merge /api/employees and /api/discounts employee lists
      let list = []
      if (empRes.employees && empRes.employees.length > 0) {
        list = empRes.employees
      } else if (dataRes.employees) {
        list = dataRes.employees
      }
      setEmployees(list)
    } catch (err) {
      showToast('Failed to load dashboard data: ' + err.message, 'error')
    } finally {
      setDataLoading(false)
    }
  }, [apiFetch, sessionToken])

  useEffect(() => {
    if (sessionToken && currentUser) {
      loadDashboardData()
    }
  }, [sessionToken, currentUser, loadDashboardData])

  // --------------------------------------------------------------------------
  // Handlers: Auth Flow
  // --------------------------------------------------------------------------
  const handleRequestLoginCode = async (e) => {
    e.preventDefault()
    if (!loginEmail || !loginEmail.includes('@')) {
      setAuthMsg({ type: 'error', text: 'Please enter a valid work email.' })
      return
    }
    setRequestingCode(true)
    setAuthMsg({ type: '', text: '' })
    try {
      const res = await fetch('/api/auth?route=request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to send login code.')
      }
      setCodeSent(true)
      setAuthMsg({
        type: 'info',
        text: data.message || 'A 4-digit code was sent to your Slack direct messages.',
      })
    } catch (err) {
      setAuthMsg({ type: 'error', text: err.message })
    } finally {
      setRequestingCode(false)
    }
  }

  const handleVerifyLoginCode = async (e) => {
    e.preventDefault()
    if (!loginCode || loginCode.trim().length < 4) {
      setAuthMsg({ type: 'error', text: 'Please enter the 4-digit verification code.' })
      return
    }
    setVerifyingCode(true)
    setAuthMsg({ type: '', text: '' })
    try {
      const res = await fetch('/api/auth?route=verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, code: loginCode.trim() }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Verification failed.')
      }
      localStorage.setItem('ksc_discount_token', data.token)
      setSessionToken(data.token)
      setCurrentUser(data.user)
      showToast(`Welcome back, ${data.user.name}!`, 'success')
    } catch (err) {
      setAuthMsg({ type: 'error', text: err.message })
    } finally {
      setVerifyingCode(false)
    }
  }

  const handleLogout = async () => {
    try {
      await fetch('/api/auth?route=logout', { method: 'POST' })
    } catch {}
    localStorage.removeItem('ksc_discount_token')
    setSessionToken('')
    setCurrentUser(null)
    setCodeSent(false)
    setLoginCode('')
    setAuthMsg({ type: '', text: '' })
  }

  // --------------------------------------------------------------------------
  // Handlers: Settings Bar
  // --------------------------------------------------------------------------
  const handleSaveSettings = async (e) => {
    e.preventDefault()
    setSavingSettings(true)
    try {
      const res = await apiFetch('/api/discounts?route=update-settings', {
        method: 'POST',
        body: JSON.stringify({
          employee_discount_percent: settings.employee_discount_percent,
          monthly_store_credit_amount: settings.monthly_store_credit_amount,
        }),
      })
      if (res.ok) {
        showToast('Settings saved successfully in Supabase!', 'success')
      }
    } catch (err) {
      showToast('Error saving settings: ' + err.message, 'error')
    } finally {
      setSavingSettings(false)
    }
  }

  // --------------------------------------------------------------------------
  // Handlers: Quick Actions (Create Email-Locked Code via /api/employees/create)
  // --------------------------------------------------------------------------
  const handleOnboardSubmit = async (e) => {
    e.preventDefault()
    if (!onboardName.trim() || !onboardEmail.trim()) {
      showToast('Full Name and Work Email are required.', 'error')
      return
    }
    setOnboarding(true)
    setLastCreatedAlert(null)
    try {
      const res = await apiFetch('/api/employees/create', {
        method: 'POST',
        body: JSON.stringify({
          full_name: onboardName.trim(),
          work_email: onboardEmail.trim(),
          discount_percentage:
            onboardDiscount !== '' && !isNaN(Number(onboardDiscount))
              ? Number(onboardDiscount)
              : Number(settings.employee_discount_percent ?? 20),
          monthly_credit_amount:
            onboardCredit !== '' && !isNaN(Number(onboardCredit))
              ? Number(onboardCredit)
              : Number(settings.monthly_store_credit_amount ?? 25),
          location_type: onboardLocation,
        }),
      })
      if (res.success || res.ok) {
        const emp = res.employee
        const code = emp.discount_code
        const empName = emp.full_name || emp.employee_name
        setLastCreatedAlert({
          code,
          name: empName,
          email: emp.work_email,
        })
        showToast(`🎉 Generated Email-Locked Code ${code} for ${empName}!`, 'success')
        setOnboardName('')
        setOnboardEmail('')
        loadDashboardData()
      }
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setOnboarding(false)
    }
  }

  const handleIssueMonthlyCreditAll = async () => {
    const activeEmployees = employees.filter((e) => (e.status || '').toLowerCase() === 'active')
    const activeCount = activeEmployees.length
    const totalAmount = activeEmployees
      .reduce((sum, e) => {
        const amt =
          e.monthly_credit_amount !== undefined && e.monthly_credit_amount !== null
            ? Number(e.monthly_credit_amount)
            : Number(settings.monthly_store_credit_amount || 0)
        return sum + amt
      }, 0)
      .toFixed(2)

    if (activeCount === 0) {
      showToast('No active employees to credit.', 'error')
      return
    }

    const confirmed = window.confirm(
      `Issue monthly store credit to all ${activeCount} active employees?\n\nTotal disbursement: $${totalAmount}`
    )
    if (!confirmed) return

    setRunningMonthlyCredit(true)
    try {
      const res = await apiFetch('/api/discounts?route=monthly-credit', {
        method: 'POST',
      })
      if (res.ok) {
        const s = res.summary
        showToast(
          `Monthly Store Credit complete! Successfully credited ${s.successful} employees ($${s.totalAmountIssued.toFixed(2)}).`,
          'success'
        )
        loadDashboardData()
      }
    } catch (err) {
      showToast('Monthly credit run failed: ' + err.message, 'error')
    } finally {
      setRunningMonthlyCredit(false)
    }
  }

  // --------------------------------------------------------------------------
  // Handlers: Table Actions & Deactivation (/api/employees/deactivate)
  // --------------------------------------------------------------------------
  const handleOpenCreditModal = (emp) => {
    setSelectedEmployee(emp)
    setCreditAmount(String(emp.monthly_credit_amount || settings.monthly_store_credit_amount || '25.00'))
    setCreditReason('Manual Employee Store Credit')
    setCreditModalOpen(true)
  }

  const handleConfirmSingleCredit = async (e) => {
    e.preventDefault()
    if (!selectedEmployee) return
    const amt = Number(creditAmount)
    if (!Number.isFinite(amt) || amt <= 0) {
      showToast('Please enter a valid credit amount greater than 0.', 'error')
      return
    }
    setIssuingCredit(true)
    try {
      const res = await apiFetch('/api/discounts?route=issue-credit', {
        method: 'POST',
        body: JSON.stringify({
          id: selectedEmployee.id,
          amount: amt,
          reason: creditReason.trim(),
        }),
      })
      if (res.ok || res.success) {
        showToast(
          `Successfully credited $${amt.toFixed(2)} to ${selectedEmployee.full_name || selectedEmployee.employee_name}!`,
          'success'
        )
        setCreditModalOpen(false)
        loadDashboardData()
      }
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setIssuingCredit(false)
    }
  }

  const handleToggleStatus = async (emp) => {
    const isCurrentlyActive = (emp.status || '').toLowerCase() === 'active'
    const empName = emp.full_name || emp.employee_name || emp.work_email

    if (isCurrentlyActive) {
      const confirmed = window.confirm(
        `Are you sure you want to deactivate discount privileges for ${empName}?\n\nThis will delete their Shopify Price Rule and deactivate their discount code.`
      )
      if (!confirmed) return

      try {
        const res = await apiFetch('/api/employees/deactivate', {
          method: 'POST',
          body: JSON.stringify({
            id: emp.id,
            price_rule_id: emp.shopify_price_rule_id || emp.shopify_discount_id,
            work_email: emp.work_email,
          }),
        })
        if (res.success || res.ok) {
          showToast(`${empName} has been deactivated and Shopify price rule removed.`, 'success')
          loadDashboardData()
        }
      } catch (err) {
        showToast(err.message, 'error')
      }
    } else {
      const confirmed = window.confirm(
        `Reactivate employee discount code for ${empName} in Shopify?`
      )
      if (!confirmed) return
      try {
        const res = await apiFetch('/api/employees/create', {
          method: 'POST',
          body: JSON.stringify({
            full_name: empName,
            work_email: emp.work_email,
            discount_percentage: emp.discount_percentage || emp.discount_percent || 20,
            monthly_credit_amount:
              emp.monthly_credit_amount !== undefined && emp.monthly_credit_amount !== null
                ? Number(emp.monthly_credit_amount)
                : 25,
            location_type: emp.location_type || 'local',
          }),
        })
        if (res.success || res.ok) {
          showToast(`Reactivated code ${res.employee.discount_code} for ${empName}!`, 'success')
          loadDashboardData()
        }
      } catch (err) {
        showToast(err.message, 'error')
      }
    }
  }

  const handleResendSlackDM = async (emp) => {
    try {
      const res = await apiFetch('/api/discounts?route=resend-dm', {
        method: 'POST',
        body: JSON.stringify({ id: emp.id }),
      })
      if (res.ok || res.success) {
        showToast(`Slack DM resent to ${emp.full_name || emp.employee_name}!`, 'success')
      }
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  const handleCopyCode = (code) => {
    navigator.clipboard?.writeText(code)
    showToast(`Copied code "${code}" to clipboard!`, 'info')
  }

  // --------------------------------------------------------------------------
  // Filtered Employees
  // --------------------------------------------------------------------------
  const filteredEmployees = employees.filter((emp) => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      (emp.full_name || emp.employee_name || '').toLowerCase().includes(q) ||
      (emp.work_email || '').toLowerCase().includes(q) ||
      (emp.discount_code || '').toLowerCase().includes(q)
    )
  })

  // --------------------------------------------------------------------------
  // Loading Splash Screen
  // --------------------------------------------------------------------------
  if (authLoading) {
    return (
      <div className="login-screen">
        <div className="login-box">
          <img src="/ksc-logo.png" alt="Kawaii Slime Company" className="login-logo" />
          <p>Connecting to Kawaii Slime Portal...</p>
        </div>
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // 1. Authentication Screen
  // --------------------------------------------------------------------------
  if (!sessionToken || !currentUser) {
    return (
      <div className="login-screen">
        <div className="login-blob pink"></div>
        <div className="login-blob blue"></div>
        <div className="login-box">
          <img src="/ksc-logo.png" alt="Kawaii Slime Company" className="login-logo" />
          <h1>Employee Discount & Store Credit</h1>
          <p>Sign in using your verified Kawaii Slime Company Slack work email.</p>

          {authMsg.text && (
            <div className={`alert-box ${authMsg.type === 'error' ? 'error' : 'info'}`}>
              {authMsg.text}
            </div>
          )}

          {!codeSent ? (
            <form onSubmit={handleRequestLoginCode} className="login-form">
              <div className="input-field-group">
                <label className="input-label" htmlFor="workEmail">
                  Slack Work Email
                </label>
                <input
                  id="workEmail"
                  type="email"
                  className="text-input"
                  placeholder="e.g. employee@kawaiislimecompany.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <button type="submit" className="btn-primary" disabled={requestingCode}>
                {requestingCode ? 'Looking up Slack user...' : 'Send 4-Digit Slack Code →'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyLoginCode} className="login-form">
              <div className="input-field-group">
                <label className="input-label" htmlFor="loginCode">
                  Enter 4-Digit Slack Code
                </label>
                <input
                  id="loginCode"
                  type="text"
                  maxLength={4}
                  className="text-input"
                  placeholder="e.g. 5821 (or 1234 in test mode)"
                  value={loginCode}
                  onChange={(e) => setLoginCode(e.target.value)}
                  style={{ textAlign: 'center', letterSpacing: '0.25em', fontSize: '18px' }}
                  required
                  autoFocus
                />
              </div>
              <button type="submit" className="btn-secondary" disabled={verifyingCode}>
                {verifyingCode ? 'Verifying...' : 'Verify & Enter Dashboard →'}
              </button>
              <button
                type="button"
                className="btn-subtle"
                style={{ textAlign: 'center', justifyContent: 'center' }}
                onClick={() => {
                  setCodeSent(false)
                  setLoginCode('')
                  setAuthMsg({ type: '', text: '' })
                }}
              >
                ← Use different email or resend code
              </button>
            </form>
          )}
        </div>
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // 2. Authenticated Dashboard Screen
  // --------------------------------------------------------------------------
  return (
    <div className="app-container">
      {/* Top Header Bar */}
      <header className="header-bar">
        <div className="header-inner">
          <div className="brand-section">
            <img src="/ksc-logo.png" alt="Kawaii Slime Company" className="brand-logo" />
            <div className="brand-text">
              <span className="brand-title">Employee Discount & Store Credit</span>
              <span className="brand-subtitle">Shopify Admin API & Supabase Sync</span>
            </div>
          </div>
          <div className="user-profile">
            <span className="role-badge">{currentUser.role || 'Admin'}</span>
            <div className="user-avatar" title={currentUser.email || currentUser.username}>
              {(currentUser.name || 'K')[0].toUpperCase()}
            </div>
            <button onClick={handleLogout} className="logout-btn" title="Sign out">
              Log Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="main-wrapper">
        {/* ================================================================= */}
        {/* SECTION 1: Configurable Settings Bar                             */}
        {/* ================================================================= */}
        <section className="settings-bar">
          <div className="settings-info">
            <div className="settings-icon">⚙️</div>
            <div>
              <h2 className="card-title">Default Employee Benefit Settings</h2>
              <p className="card-desc">
                Saved in Supabase <code style={{ fontSize: '11px' }}>public.discount_settings</code>.
                Applied to new onboards and monthly store credit distributions.
              </p>
            </div>
          </div>

          <form onSubmit={handleSaveSettings} className="settings-inputs">
            <div className="input-field-group">
              <label className="input-label" htmlFor="discountPercent">
                Employee Discount (%)
              </label>
              <div className="input-wrapper">
                <input
                  id="discountPercent"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  className="text-input input-with-suffix"
                  style={{ width: '120px' }}
                  value={settings.employee_discount_percent}
                  onChange={(e) =>
                    setSettings({ ...settings, employee_discount_percent: Number(e.target.value) })
                  }
                  required
                />
                <span className="input-suffix">%</span>
              </div>
            </div>

            <div className="input-field-group">
              <label className="input-label" htmlFor="monthlyCredit">
                Monthly Store Credit ($)
              </label>
              <div className="input-wrapper">
                <span className="input-prefix">$</span>
                <input
                  id="monthlyCredit"
                  type="number"
                  min="0"
                  step="0.50"
                  className="text-input input-with-prefix"
                  style={{ width: '130px' }}
                  value={settings.monthly_store_credit_amount}
                  onChange={(e) =>
                    setSettings({ ...settings, monthly_store_credit_amount: Number(e.target.value) })
                  }
                  required
                />
              </div>
            </div>

            <button type="submit" className="btn-secondary" disabled={savingSettings}>
              {savingSettings ? 'Saving...' : '💾 Save Settings'}
            </button>
          </form>
        </section>

        {/* ================================================================= */}
        {/* SECTION 2: Quick Actions (Create Email-Locked Code Form)          */}
        {/* ================================================================= */}
        <section className="quick-actions-grid">
          {/* Action 1: Onboard Employee (calls /api/employees/create) */}
          <div className="action-card">
            <div>
              <h2 className="card-title">
                <span>➕</span> Onboard Employee
              </h2>
              <p className="card-desc">
                Creates an email-locked discount code in Shopify via <code style={{ fontSize: '11px' }}>POST /api/employees/create</code> and saves to Supabase.
                Format: <code style={{ fontSize: '11px' }}>EMP-FIRSTNAME-1234</code>.
              </p>
            </div>

            {lastCreatedAlert && (
              <div className="alert-box success" style={{ margin: '10px 0 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <strong>🎉 Generated Code:</strong> <code style={{ fontSize: '13px', fontWeight: 800 }}>{lastCreatedAlert.code}</code> locked to <strong>{lastCreatedAlert.email}</strong>!
                </div>
                <button
                  type="button"
                  className="copy-btn"
                  onClick={() => handleCopyCode(lastCreatedAlert.code)}
                  title="Copy code"
                >
                  📋 Copy
                </button>
              </div>
            )}

            <form onSubmit={handleOnboardSubmit} className="onboard-form">
              <div className="onboard-fields-grid">
                <div className="input-field-group">
                  <label className="input-label" htmlFor="newEmpName">
                    Full Name
                  </label>
                  <input
                    id="newEmpName"
                    type="text"
                    className="text-input"
                    placeholder="e.g. Zunair Rafiq"
                    value={onboardName}
                    onChange={(e) => setOnboardName(e.target.value)}
                    required
                  />
                </div>

                <div className="input-field-group">
                  <label className="input-label" htmlFor="newEmpEmail">
                    Work Email
                  </label>
                  <input
                    id="newEmpEmail"
                    type="email"
                    className="text-input"
                    placeholder="zunair@kawaiislimecompany.com"
                    value={onboardEmail}
                    onChange={(e) => setOnboardEmail(e.target.value)}
                    required
                  />
                </div>

                <div className="input-field-group">
                  <label className="input-label" htmlFor="newEmpDiscount">
                    Discount %
                  </label>
                  <div className="input-wrapper">
                    <input
                      id="newEmpDiscount"
                      type="number"
                      min="1"
                      max="100"
                      className="text-input input-with-suffix"
                      value={onboardDiscount}
                      onChange={(e) => setOnboardDiscount(e.target.value)}
                      required
                    />
                    <span className="input-suffix">%</span>
                  </div>
                </div>

                <div className="input-field-group">
                  <label className="input-label" htmlFor="newEmpCredit">
                    Credit ($)
                  </label>
                  <div className="input-wrapper">
                    <span className="input-prefix">$</span>
                    <input
                      id="newEmpCredit"
                      type="number"
                      min="0"
                      step="0.50"
                      className="text-input input-with-prefix"
                      value={onboardCredit}
                      onChange={(e) => setOnboardCredit(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="input-field-group">
                  <label className="input-label" htmlFor="newEmpLocation">
                    Delivery Type
                  </label>
                  <select
                    id="newEmpLocation"
                    className="select-input"
                    value={onboardLocation}
                    onChange={(e) => setOnboardLocation(e.target.value)}
                  >
                    <option value="local">Local - Warehouse Pickup</option>
                    <option value="remote">Remote - Home Shipping</option>
                  </select>
                </div>

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={onboarding}
                  style={{ height: '42px' }}
                >
                  {onboarding ? 'Creating in Shopify...' : '+ Create & Lock Code'}
                </button>
              </div>
            </form>
          </div>

          {/* Action 2: Run Monthly Store Credit (Test Run) */}
          <div className="action-card">
            <div>
              <h2 className="card-title">
                <span>🎁</span> Run Monthly Credit Now (Test Run)
              </h2>
              <p className="card-desc">
                Immediately credits all currently <strong>Active</strong> employees in Shopify using the configured{' '}
                <strong>${Number(settings.monthly_store_credit_amount).toFixed(2)}</strong> store credit
                via Shopify GraphQL <code style={{ fontSize: '11px' }}>storeCreditAccountCredit</code>. Logs each run in Supabase <code style={{ fontSize: '11px' }}>credit_ledger</code>.
              </p>
            </div>

            <div className="credit-run-box">
              <div className="credit-run-stats">
                <span className="credit-run-title">
                  {employees.filter((e) => (e.status || '').toLowerCase() === 'active').length} Active Employees
                </span>
                <span className="credit-run-desc">
                  Total disbursement: $
                  {employees
                    .filter((e) => (e.status || '').toLowerCase() === 'active')
                    .reduce((sum, e) => {
                      const amt =
                        e.monthly_credit_amount !== undefined && e.monthly_credit_amount !== null
                          ? Number(e.monthly_credit_amount)
                          : Number(settings.monthly_store_credit_amount || 0)
                      return sum + amt
                    }, 0)
                    .toFixed(2)}
                </span>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleIssueMonthlyCreditAll}
                disabled={runningMonthlyCredit || employees.filter((e) => (e.status || '').toLowerCase() === 'active').length === 0}
              >
                {runningMonthlyCredit ? 'Distributing Credits...' : '⚡ Run Monthly Credit Now'}
              </button>
            </div>
          </div>
        </section>

        {/* ================================================================= */}
        {/* SECTION 3: Employee Discount & Credit Table                      */}
        {/* ================================================================= */}
        <section className="card-box">
          <div className="card-box-header">
            <div>
              <h2 className="card-title">
                <span>📋</span> Employee Discount & Store Credit Directory
              </h2>
              <p className="card-desc">
                Showing {filteredEmployees.length} of {employees.length} employees. Codes are strictly
                locked to work emails at checkout.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <input
                type="search"
                className="text-input"
                placeholder="Search by name, email, or code..."
                style={{ width: '260px' }}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button
                type="button"
                className="btn-subtle"
                onClick={loadDashboardData}
                disabled={dataLoading}
                title="Refresh table"
              >
                🔄 Refresh
              </button>
            </div>
          </div>

          <div className="table-container">
            <table className="employee-table">
              <thead>
                <tr>
                  <th>Employee Name</th>
                  <th>Work Email</th>
                  <th>Slack ID</th>
                  <th>Unique Discount Code</th>
                  <th>Discount %</th>
                  <th>Monthly Credit</th>
                  <th>Delivery Type</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '40px 14px', color: '#b47a4f' }}>
                      {dataLoading ? 'Loading employee records...' : 'No employees found matching criteria.'}
                    </td>
                  </tr>
                ) : (
                  filteredEmployees.map((emp) => {
                    const empName = emp.full_name || emp.employee_name || 'Staff'
                    const initials = empName
                      .split(' ')
                      .map((p) => p[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()
                    const isActive = (emp.status || '').toLowerCase() === 'active'
                    const discountVal = emp.discount_percentage || emp.discount_percent || 20
                    const creditVal =
                      emp.monthly_credit_amount !== undefined && emp.monthly_credit_amount !== null
                        ? emp.monthly_credit_amount
                        : (emp.total_credit_issued ?? 25)
                    const locationType = emp.location_type || 'local'

                    return (
                      <tr key={emp.id || emp.work_email}>
                        {/* Name */}
                        <td>
                          <div className="emp-name-cell">
                            <div className="emp-initials">{initials}</div>
                            <div className="emp-info">
                              <strong>{empName}</strong>
                              <span>{emp.shopify_customer_id ? `Shopify Cust: ${emp.shopify_customer_id}` : 'Synced'}</span>
                            </div>
                          </div>
                        </td>

                        {/* Email */}
                        <td>
                          <span style={{ fontWeight: 600 }}>{emp.work_email}</span>
                        </td>

                        {/* Slack ID */}
                        <td>
                          {emp.slack_user_id ? (
                            <code style={{ fontSize: '11px', background: '#f5eaef', padding: '2px 6px', borderRadius: '4px', color: '#6a3c1f' }}>
                              {emp.slack_user_id}
                            </code>
                          ) : (
                            <span style={{ fontSize: '12px', color: '#a08579' }}>Auto on join</span>
                          )}
                        </td>

                        {/* Code */}
                        <td>
                          <div className="discount-code-badge">
                            <span>{emp.discount_code}</span>
                            <button
                              type="button"
                              className="copy-btn"
                              title="Copy code"
                              onClick={() => handleCopyCode(emp.discount_code)}
                            >
                              📋
                            </button>
                          </div>
                        </td>

                        {/* Discount % */}
                        <td>
                          <span style={{ fontWeight: 800, color: 'var(--brown)' }}>
                            {discountVal}% OFF
                          </span>
                        </td>

                        {/* Monthly Credit */}
                        <td>
                          <div>
                            <strong style={{ color: 'var(--green)' }}>
                              ${Number(creditVal).toFixed(2)}
                            </strong>
                          </div>
                        </td>

                        {/* Delivery Type */}
                        <td>
                          {locationType === 'remote' ? (
                            <span className="badge-delivery remote">📦 Home Shipping</span>
                          ) : (
                            <span className="badge-delivery">🏢 Local Pickup</span>
                          )}
                        </td>

                        {/* Status */}
                        <td>
                          <span className={`status-pill ${isActive ? 'active' : 'revoked'}`}>
                            {isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>

                        {/* Actions */}
                        <td>
                          <div className="table-actions" style={{ justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              className="btn-subtle success"
                              onClick={() => handleOpenCreditModal(emp)}
                              disabled={!isActive}
                              title="Issue Store Credit"
                            >
                              💵 Issue Credit
                            </button>

                            <button
                              type="button"
                              className={`btn-subtle ${isActive ? 'danger' : 'success'}`}
                              onClick={() => handleToggleStatus(emp)}
                              title={isActive ? 'Delete Shopify price rule & deactivate' : 'Reactivate in Shopify'}
                            >
                              {isActive ? '🚫 Deactivate' : '✅ Reactivate'}
                            </button>

                            <button
                              type="button"
                              className="btn-subtle"
                              onClick={() => handleResendSlackDM(emp)}
                              title="Resend Slack Welcome & Perk DM"
                            >
                              💬 Resend DM
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent Store Credit Audit Logs */}
        {recentLogs.length > 0 && (
          <section className="card-box" style={{ background: '#fffefd' }}>
            <div className="card-box-header">
              <div>
                <h3 className="card-title" style={{ fontSize: '14px' }}>
                  <span>📜</span> Recent Store Credit Activity Log
                </h3>
                <p className="card-desc">Audit trail of transactions from Shopify store credit mutations</p>
              </div>
            </div>
            <div className="table-container">
              <table className="employee-table">
                <thead>
                  <tr>
                    <th>Date & Time</th>
                    <th>Employee</th>
                    <th>Amount</th>
                    <th>Reason</th>
                    <th>Shopify Transaction ID</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogs.slice(0, 8).map((log) => (
                    <tr key={log.id}>
                      <td>{new Date(log.created_at).toLocaleString()}</td>
                      <td>
                        <strong>{log.employee_name}</strong> ({log.work_email})
                      </td>
                      <td>
                        <strong style={{ color: log.status === 'Success' ? 'var(--green)' : 'var(--red)' }}>
                          ${Number(log.amount).toFixed(2)}
                        </strong>
                      </td>
                      <td>{log.reason}</td>
                      <td>
                        <code style={{ fontSize: '11px', color: 'var(--brown-soft)' }}>
                          {log.shopify_transaction_id ? log.shopify_transaction_id.slice(-16) : 'N/A'}
                        </code>
                      </td>
                      <td>
                        <span className={`status-pill ${log.status === 'Success' ? 'active' : 'revoked'}`}>
                          {log.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* =================================================================== */}
      {/* Modal: Issue Store Credit to Single Employee                        */}
      {/* =================================================================== */}
      {creditModalOpen && selectedEmployee && (
        <div className="modal-overlay" onClick={() => setCreditModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">Issue Store Credit</h3>
                <p className="modal-desc">
                  Credit Shopify account for <strong>{selectedEmployee.full_name || selectedEmployee.employee_name}</strong> (
                  {selectedEmployee.work_email})
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setCreditModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleConfirmSingleCredit}>
              <div className="input-field-group" style={{ marginBottom: '14px' }}>
                <label className="input-label" htmlFor="creditAmtInput">
                  Store Credit Amount ($ USD)
                </label>
                <div className="input-wrapper">
                  <span className="input-prefix">$</span>
                  <input
                    id="creditAmtInput"
                    type="number"
                    min="1"
                    step="0.50"
                    className="text-input input-with-prefix"
                    value={creditAmount}
                    onChange={(e) => setCreditAmount(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
              </div>

              <div className="input-field-group" style={{ marginBottom: '14px' }}>
                <label className="input-label" htmlFor="creditReasonInput">
                  Reason / Memo (Logged for audit)
                </label>
                <input
                  id="creditReasonInput"
                  type="text"
                  className="text-input"
                  placeholder="e.g. Monthly Employee Perk, Birthday Gift, Special Bonus"
                  value={creditReason}
                  onChange={(e) => setCreditReason(e.target.value)}
                  required
                />
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-subtle"
                  onClick={() => setCreditModalOpen(false)}
                  disabled={issuingCredit}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-secondary" disabled={issuingCredit}>
                  {issuingCredit ? 'Crediting Shopify...' : `Issue $${Number(creditAmount || 0).toFixed(2)} Store Credit`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Floating Toast Message */}
      {toast && (
        <div className="toast-msg">
          <span>{toast.type === 'error' ? '⚠️' : toast.type === 'success' ? '✅' : 'ℹ️'}</span>
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  )
}
