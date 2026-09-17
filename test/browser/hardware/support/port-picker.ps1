# Answers Chromium's serial port picker through Windows UI Automation (port-picker.ts calls this).
#
# The picker is browser UI, not page content: no page script and no DevTools command can see or
# click it. To UI Automation it is a pane named after the asking origin, holding one item per
# offered port and, after them, two buttons - connect, then cancel. It is found by that shape and by
# the origin in its name, never by a button's label, which is in the browser's language.
#
#   -Action list     prints the offered ports as a JSON array of their names
#   -Action pick     selects the port whose name contains -Port, and connects
#   -Action cancel   dismisses the picker
#
# Exits with 2 when no picker of that origin is open or ready yet, with 3 when the port is not
# offered.
param(
  [Parameter(Mandatory = $true)][string]$ProfileDirectory,
  [Parameter(Mandatory = $true)][string]$Origin,
  [ValidateSet('list', 'pick', 'cancel')][string]$Action = 'list',
  [string]$Port = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$automation = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$everything = [System.Windows.Automation.Condition]::TrueCondition
# The browser under test is the one started with this profile; the user's own browser is left alone.
$processIds = @(Get-CimInstance Win32_Process |
  Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.Contains($ProfileDirectory) } |
  ForEach-Object { [int]$_.ProcessId })

function Test-Type($element, [string]$type) {
  return $element.Current.ControlType.ProgrammaticName -eq "ControlType.$type"
}

$picker = $null
foreach ($window in $automation::RootElement.FindAll($scope::Children, $everything)) {
  if ($processIds -notcontains $window.Current.ProcessId) { continue }
  foreach ($element in $window.FindAll($scope::Descendants, $everything)) {
    if ((Test-Type $element 'Pane') -and $element.Current.Name.Contains($Origin)) {
      $picker = $element
      break
    }
  }
  if ($null -ne $picker) { break }
}
if ($null -eq $picker) {
  [Console]::Error.WriteLine("No port picker of $Origin is open.")
  exit 2
}

$ports = @()
$buttonsAfterPorts = @()
foreach ($element in $picker.FindAll($scope::Descendants, $everything)) {
  # The row and the cell in it are both data items; the cell carries the port's name.
  if ((Test-Type $element 'DataItem') -and $element.Current.Name -ne '') { $ports += $element }
  elseif ((Test-Type $element 'Button') -and $ports.Count -gt 0) { $buttonsAfterPorts += $element }
}
# An empty picker has no item to come after: its last two buttons are connect and cancel all the same.
if ($ports.Count -eq 0) {
  $buttons = @($picker.FindAll($scope::Descendants, $everything) | Where-Object { Test-Type $_ 'Button' })
  $buttonsAfterPorts = @($buttons | Select-Object -Last 2)
}

if ($Action -eq 'list') {
  # UTF-8 whatever the console's code page: a port's name is the vendor's, in any script.
  $json = ConvertTo-Json -Compress -InputObject @($ports | ForEach-Object { $_.Current.Name })
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  exit 0
}

$invoke = [System.Windows.Automation.InvokePattern]::Pattern
if ($Action -eq 'cancel') {
  $buttonsAfterPorts[-1].GetCurrentPattern($invoke).Invoke()
  exit 0
}

$wanted = $ports | Where-Object { $_.Current.Name.Contains($Port) } | Select-Object -First 1
if ($null -eq $wanted) {
  [Console]::Error.WriteLine("The picker does not offer a port named like '$Port'.")
  exit 3
}
# The name sits on the cell or on the row, depending on when the picker is asked; whichever of the
# two can be selected is the one to select.
$selection = [System.Windows.Automation.SelectionItemPattern]::Pattern
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$pattern = $null
$candidate = $wanted
for ($level = 0; $level -lt 3 -and $null -ne $candidate; $level += 1) {
  if ($candidate.TryGetCurrentPattern($selection, [ref]$pattern)) { break }
  $candidate = $walker.GetParent($candidate)
}
if ($null -eq $pattern) {
  [Console]::Error.WriteLine("The port '$($wanted.Current.Name)' cannot be selected yet.")
  exit 2
}
$pattern.Select()
Start-Sleep -Milliseconds 300
$buttonsAfterPorts[0].GetCurrentPattern($invoke).Invoke()
exit 0
