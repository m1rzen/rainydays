!macro customInstall
  SetShellVarContext current
  Delete "$DESKTOP\Mini-Lux.lnk"
  Delete "$SMPROGRAMS\Mini-Lux.lnk"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro customUnInstall
  SetShellVarContext current
  Delete "$DESKTOP\RainyDays.lnk"
  Delete "$SMPROGRAMS\RainyDays.lnk"
  Delete "$DESKTOP\Mini-Lux.lnk"
  Delete "$SMPROGRAMS\Mini-Lux.lnk"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend
