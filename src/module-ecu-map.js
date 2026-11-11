// 981 顶层块：0x0E 代 sysId（2026-11-10 换表，tools/export-981-sysids.py 48/48 全解）
//   证据链：9X1_ALLDATA 目录/变体名投票 + SYS_DATA name-9 段记录（57900-81500）→ data/981-sysids.json
//   （变体名投票 = 变体行名在多代记录中的 sysId 指派；name-9 = flag u16@name-11、sysId u32@name-9、len u16@name-2）
//   旧 0x0B 代值（换表前，供跨代回退/历史对账）：Airbag 0x0b04、Gateway 0x0b09、DME 0x0b01、
//   Kombi 0x0b08、PDK 0x0b02、Waehlhebel 0x0b02、PDC 0x0b12、PASM 0x0b13、BCM_vo 0x0b20、
//   BCM_hi 0x0b23、Sitz 0x0b4c、Frontkamera 0x0b4a、Rueck 0x0b51、TuerF 0x0b1e、TuerB 0x0b1f、
//   Scheinwerfer 0x0b58、Lenkhilfe 0x0b45、RDK 0x0b37、EPB 0x0b32、ACC3 0x0b40、
//   Verstaerker 0x0b41、Head_Unit 0x0b46。
//   双记录模块（左右件）：sysIds 数组在 981-sysids.json，此处取首枚（左/主）：
//     SCHEINWERFER_LED [0x0e2f,0x0e30]、Sitzsteuergeraet [0x0e4c,0x0e4e]、
//     TUER_VORNE [0x0e1e,0x0e1f]、TUER_HINTEN [0x0e4f,0x0e50]、Hinterachslenkung [0x0e59,0x0e5a]。
export const MODULE_TO_ECUID = {
  "Airbag": "0x0e04",
  "CAN_CAN_Gateway": "0x0e09",
  "DME_BDE_Continental": "0x0e01",
  "BV_ECM_UDS": "0x0e01",
  "BV_EnginContrModul1UDS": "0x0e01",
  "MED17_1_11": "0x0e01",
  "Kombiinstrument_MM": "0x0e08",
  "Getriebesteuerung_PDK": "0x0e02",
  "Waehlhebel": "0x0e44",
  "PDC": "0x0e12",
  "PASM": "0x0e13",
  "PASM_PADM": "0x0e13",
  "BCM_vorne": "0x0e20",
  "BCM_hinten": "0x0e23",
  "Airbags": "0x0e04",
  "Sitzsteuergeraet": "0x0e4c",
  "Frontkamera": "0x0e4a",
  "Rueckfahrkamera_II": "0x0e51",
  "TUER_VORNE": "0x0e1e",
  "TUER_HINTEN": "0x0e4f",
  "SCHEINWERFER": "0x0e58",
  "SCHEINWERFER_LED": "0x0e2f",
  "SWSG": "0x0e2f",
  "Lenkhilfe": "0x0e45",
  "Steering_Control_Unit": "0x0e45",
  "Hinterachslenkung": "0x0e59",
  "RDK": "0x0e37",
  "RDK3": "0x0e37",
  "EPB": "0x0e32",
  "ACC3": "0x0e40",
  "Verstaerker": "0x0e41",
  "BV_SoundSysteUDS": "0x0e41",
  "Head_Unit": "0x0e46",
  "BV_InforContrUnit1UDS": "0x0e46",
  "BV_InforContrUnit1UDSDesay": "0x0e46",
  "BV_TVTunerUDS": "0x0e4b",
  "TVTuner": "0x0e4b",
  "Zusatzinstrument": "0x0e1d",
  "Lenkstockschalter": "0x0e36",
  "BV_ContrUnitLaneChangAssis2UDS": "0x0f4d",
  "BV_ActuaForStrucBorneSoundUDS": "0x0e57",
  "ERA_GLONASS": "0x0ea5",
  "ERA_GLONASS_VFA": "0x0ea5",
  "Verdeck_Synchronisation": "0x0e27",
  "Verdeck_Targa": "0x0e27",
  "Lift_VA": "0x0e5b",
  "Lift_VA_Gen2": "0x0e5b",
  "PDCC_2": "0x0e2b",
  "Allrad": "0x0e52",

  // ---- 2026-11-08 覆盖审计①名字证据链补录（tools/build-module-disposition.py，证据见 data/module-disposition-252.tsv）----
  "9x6_DME_M_5_2_2": "0x0b01", // 同组name-9 | 同组/DIR | 模块名 '9x6_DME_M_5_2_2' 规范化 '9x6dmem522' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "9x6_Kombi": "0x0e08", // 同组name-9 | 同组/DIR | 模块名 '9x6_Kombi' 规范化 '9x6kombi' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "9x6_TargaDach": "0x0e27", // 同组name-9 | 同组/DIR | 模块名 '9x6_TargaDach' 规范化 '9x6targadach' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "9x6_Tiptronic_G40G50": "0x0c02", // 同组name-9 | 同组/DIR | 模块名 '9x6_Tiptronic_G40G50' 规范化 '9x6tiptronicg40g50' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "9x6_Tiptronic_GTOP": "0x0c02", // 同组name-9 | 同组/DIR | 模块名 '9x6_Tiptronic_GTOP' 规范化 '9x6tiptronicgtop' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "9x6_Verdeck": "0x0e27", // 同组name-9 | 同组/DIR | 模块名 '9x6_Verdeck' 规范化 '9x6verdeck' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "9x6_pdc": "0x0b12", // 同组name-9 | 同组/DIR | 模块名 '9x6_pdc' 规范化 '9x6pdc' 在 SYS_DATA 名字表 3961 条全表检索零命中
  // Allrad 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | Allrad_BaseSys | SYS_DATA 名字 'Allrad_BaseSys' @off=33805 flag=1 sysId@name-9=0x0B35（名 hex 41 6c 6c 72 61 64
  "Anhaenger": "0x0f54", // 名字name-9→DIR代际 | Anhaenger_BaseSys | SYS_DATA 名字 'Anhaenger_BaseSys' @off=42810 flag=1 sysId@name-9=0x0B54（名 hex 41 6e 68 61 65
  "AnzeigenDomaenenRechner": "0x0e08", // 同组name-9 | AnzeigenDomaenenRechner_BaseSys | SYS_DATA 名字 'AnzeigenDomaenenRechner_BaseSys' @off=262420 flag=0 sysId@name-9=0x0000（名 hex
  "BKE": "0x0b07", // 名字name-9 | BKE_BaseSys | SYS_DATA 名字 'BKE_BaseSys' @off=27897 flag=1 sysId@name-9=0x0B07（名 hex 42 4b 45 5f 42 61 73
  "BKV": "0x0c05", // 同组name-9 | BKV_BaseSys | SYS_DATA 名字 'BKV_BaseSys' @off=263261 flag=0 sysId@name-9=0x0000（名 hex 42 4b 56 5f 42 61 7
  "BMS2": "0x0b42", // 名字name-9 | BMS2_BaseSys | SYS_DATA 名字 'BMS2_BaseSys' @off=35822 flag=1 sysId@name-9=0x0B42（名 hex 42 4d 53 32 5f 42 6
  "BV_ActuaForExterNoiseUDS": "0x0b82", // 名字name-9 | BV_ActuaForExterNoiseUDS_BaseSys | SYS_DATA 名字 'BV_ActuaForExterNoiseUDS_BaseSys' @off=39365 flag=1 sysId@name-9=0x0B82（名 hex
  // BV_ActuaForStrucBorneSoundUDS 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | BV_ActuaForStrucBorneSoundUDS_BaseSys | SYS_DATA 名字 'BV_ActuaForStrucBorneSoundUDS_BaseSys' @off=38787 flag=1 sysId@name-9=0x0B57（
  "BV_AdaptCruisContr2UDS": "0x0b40", // 同组name-9 | BV_AdaptCruisContr2UDS_BaseSys | SYS_DATA 名字 'BV_AdaptCruisContr2UDS_BaseSys' @off=302031 flag=0 sysId@name-9=0x0000（名 hex 
  "BV_AdaptCruisContrInnoDriveUDS": "0x0b40", // 同组name-9 | BV_AdaptCruisContrInnoDriveUDS_BaseSys | SYS_DATA 名字 'BV_AdaptCruisContrInnoDriveUDS_BaseSys' @off=267580 flag=0 sysId@name-9=0x000
  "BV_AdaptCruisContrUDS": "0x0b40", // 同组name-9 | BV_AdaptCruisContrUDS_BaseSys | SYS_DATA 名字 'BV_AdaptCruisContrUDS_BaseSys' @off=267769 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_AirCondiComprUDS": "0x0b48", // 名字name-9 | BV_AirCondiComprUDS_BaseSys | SYS_DATA 名字 'BV_AirCondiComprUDS_BaseSys' @off=37262 flag=1 sysId@name-9=0x0B48（名 hex 42 5
  "BV_AirCondiUDS": "0x0b07", // 同组name-9 | BV_AirCondiUDS_BaseSys | SYS_DATA 名字 'BV_AirCondiUDS_BaseSys' @off=268967 flag=0 sysId@name-9=0x0000（名 hex 42 56 5f
  "BV_AirbaUDS": "0x0b04", // 同组name-9 | BV_AirbaUDS_BaseSys | SYS_DATA 名字 'BV_AirbaUDS_BaseSys' @off=268459 flag=0 sysId@name-9=0x0000（名 hex 42 56 5f 41
  "BV_AllWheelContrUDS": "0x0b35", // 同组name-9 | BV_AllWheelContrUDS_BaseSys | SYS_DATA 名字 'BV_AllWheelContrUDS_BaseSys' @off=269191 flag=0 sysId@name-9=0x0000（名 hex 42 
  "BV_AnaloClockUDS": "0x0b1d", // DIR行族 | BV_AnaloClockUDS_BaseSys | SYS_DATA 名字 'BV_AnaloClockUDS_BaseSys' @off=269506 flag=0 sysId@name-9=0x0000（名 hex 42 56 
  "BV_BKE": "0x0b07", // 同组name-9 | 同组/DIR | 模块名 'BV_BKE' 规范化 'bvbke' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "BV_BatteChargContrModulUDS": "0x0b70", // 名字name-9 | BV_BatteChargContrModulUDS_BaseSys | SYS_DATA 名字 'BV_BatteChargContrModulUDS_BaseSys' @off=38020 flag=1 sysId@name-9=0x0B70（名 h
  "BV_BatteEnergContrModul2UDS": "0x0b42", // DIR行族 | BV_BatteEnergContrModul2UDS_BaseSys | SYS_DATA 名字 'BV_BatteEnergContrModul2UDS_BaseSys' @off=271745 flag=0 sysId@name-9=0x0000（名
  "BV_BatteEnergContrModulUDS": "0x0b42", // DIR行族 | BV_BatteEnergContrModulUDS_BaseSys | SYS_DATA 名字 'BV_BatteEnergContrModulUDS_BaseSys' @off=36005 flag=0 sysId@name-9=0x66000000
  "BV_BatteJunctBoxUDS": "0x0b42", // DIR行族 | BV_BatteJunctBoxUDS_BaseSys | SYS_DATA 名字 'BV_BatteJunctBoxUDS_BaseSys' @off=272254 flag=0 sysId@name-9=0x0000（名 hex 42 
  "BV_BatteMonitContrModulUDS": "0x0b42", // DIR行族 | BV_BatteMonitContrModulUDS_BaseSys | SYS_DATA 名字 'BV_BatteMonitContrModulUDS_BaseSys' @off=272435 flag=0 sysId@name-9=0x0000（名 
  "BV_BeameModulMatriHeadlLeftUDS": "0x0f58", // 同组name-9 | BV_BeameModulMatriHeadlLeftUDS_BaseSys | SYS_DATA 名字 'BV_BeameModulMatriHeadlLeftUDS_BaseSys' @off=299722 flag=0 sysId@name-9=0x000
  "BV_BeameModulMatriHeadlRightUDS": "0x0f58", // 同组name-9 | BV_BeameModulMatriHeadlRightUDS_BaseSys | SYS_DATA 名字 'BV_BeameModulMatriHeadlRightUDS_BaseSys' @off=299529 flag=0 sysId@name-9=0x00
  "BV_BedienSG_hi_MSB": "0x0b36", // 同组name-9 | BV_BedienSG_hi_MSB_BaseSys | SYS_DATA 名字 'BV_BedienSG_hi_MSB_BaseSys' @off=272715 flag=0 sysId@name-9=0x0000（名 hex 42 5
  "BV_BedienSG_vo_MSB": "0x0b36", // 同组name-9 | BV_BedienSG_vo_MSB_BaseSys | SYS_DATA 名字 'BV_BedienSG_vo_MSB_BaseSys' @off=273096 flag=0 sysId@name-9=0x0000（名 hex 42 5
  "BV_Brake1UDS": "0x0c05", // 同组name-9 | BV_Brake1UDS_BaseSys | SYS_DATA 名字 'BV_Brake1UDS_BaseSys' @off=273496 flag=0 sysId@name-9=0x0000（名 hex 42 56 5f 4
  "BV_BrakeBoostUDS": "0x0c05", // 同组name-9 | BV_BrakeBoostUDS_BaseSys | SYS_DATA 名字 'BV_BrakeBoostUDS_BaseSys' @off=274674 flag=0 sysId@name-9=0x0000（名 hex 42 56 
  "BV_CamerSysteRearViewUDS": "0x0e51", // 同组name-9 | BV_CamerSysteRearViewUDS_BaseSys | SYS_DATA 名字 'BV_CamerSysteRearViewUDS_BaseSys' @off=275344 flag=0 sysId@name-9=0x0000（名 he
  "BV_CellModulContr1UDS": "0x0b42", // DIR行族 | BV_CellModulContr1UDS_BaseSys | SYS_DATA 名字 'BV_CellModulContr1UDS_BaseSys' @off=275769 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_CellModulContr2UDS": "0x0b42", // DIR行族 | BV_CellModulContr2UDS_BaseSys | SYS_DATA 名字 'BV_CellModulContr2UDS_BaseSys' @off=275954 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_CellModulContr3UDS": "0x0b42", // DIR行族 | BV_CellModulContr3UDS_BaseSys | SYS_DATA 名字 'BV_CellModulContr3UDS_BaseSys' @off=276139 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_CellModulContr4UDS": "0x0b42", // DIR行族 | BV_CellModulContr4UDS_BaseSys | SYS_DATA 名字 'BV_CellModulContr4UDS_BaseSys' @off=276324 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_CellModulContr5UDS": "0x0b42", // DIR行族 | BV_CellModulContr5UDS_BaseSys | SYS_DATA 名字 'BV_CellModulContr5UDS_BaseSys' @off=276509 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_CellModulContr6UDS": "0x0b42", // DIR行族 | BV_CellModulContr6UDS_BaseSys | SYS_DATA 名字 'BV_CellModulContr6UDS_BaseSys' @off=276694 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_CellModulContr7UDS": "0x0b42", // DIR行族 | BV_CellModulContr7UDS_BaseSys | SYS_DATA 名字 'BV_CellModulContr7UDS_BaseSys' @off=276879 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_CellModulContr8UDS": "0x0b42", // DIR行族 | BV_CellModulContr8UDS_BaseSys | SYS_DATA 名字 'BV_CellModulContr8UDS_BaseSys' @off=277064 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_CentrElectUDS": "0x0b20", // 同组name-9 | BV_CentrElectUDS_BaseSys | SYS_DATA 名字 'BV_CentrElectUDS_BaseSys' @off=277249 flag=0 sysId@name-9=0x0000（名 hex 42 56 
  "BV_CentrModulComfoSysteUDS": "0x0b20", // 同组name-9 | BV_CentrModulComfoSysteUDS_BaseSys | SYS_DATA 名字 'BV_CentrModulComfoSysteUDS_BaseSys' @off=278047 flag=0 sysId@name-9=0x0000（名 
  "BV_ChassContrUDS": "0x0e13", // 同组name-9 | BV_ChassContrUDS_BaseSys | SYS_DATA 名字 'BV_ChassContrUDS_BaseSys' @off=278938 flag=0 sysId@name-9=0x0000（名 hex 42 56 
  "BV_ContrHeadRearLeftUDS": "0x0e30", // 同组name-9 | BV_ContrHeadRearLeftUDS_BaseSys | SYS_DATA 名字 'BV_ContrHeadRearLeftUDS_BaseSys' @off=280579 flag=0 sysId@name-9=0x0000（名 hex
  "BV_ContrHeadRearRightUDS": "0x0e30", // 同组name-9 | BV_ContrHeadRearRightUDS_BaseSys | SYS_DATA 名字 'BV_ContrHeadRearRightUDS_BaseSys' @off=280812 flag=0 sysId@name-9=0x0000（名 he
  "BV_ContrUnitDigitMatriLightUDS": "0x0f58", // 同组name-9 | BV_ContrUnitDigitMatriLightUDS_BaseSys | SYS_DATA 名字 'BV_ContrUnitDigitMatriLightUDS_BaseSys' @off=299913 flag=0 sysId@name-9=0x000
  "BV_ContrUnitHandsOnDetecSteerWheelUDS": "0x0b36", // 同组name-9 | 同组/DIR | 模块名 'BV_ContrUnitHandsOnDetecSteerWheelUDS' 规范化 'bvcontrunithandsondetecsteerwheeluds' 在 S
  // BV_ContrUnitLaneChangAssis2UDS 同值重复键已删除。 // DIR行族 | BV_ContrUnitLaneChangAssis2UDS_BaseSys | SYS_DATA 名字 'BV_ContrUnitLaneChangAssis2UDS_BaseSys' @off=82012 flag=0 sysId@name-9=0x0000
  "BV_DashBoardUDS": "0x0508", // 名字name-9→DIR代际 | BV_DashBoardUDS_BaseSys | SYS_DATA 名字 'BV_DashBoardUDS_BaseSys' @off=315686 flag=1 sysId@name-9=0x1208（名 hex 42 56 5
  "BV_DeckLidContrUnitUDS": "0x0b34", // DIR行族 | BV_DeckLidContrUnitUDS_BaseSys | SYS_DATA 名字 'BV_DeckLidContrUnitUDS_BaseSys' @off=283078 flag=0 sysId@name-9=0x0000（名 hex 
  "BV_DoorElectDriveSideUDS": "0x0b1e", // 同组name-9 | BV_DoorElectDriveSideUDS_BaseSys | SYS_DATA 名字 'BV_DoorElectDriveSideUDS_BaseSys' @off=283693 flag=0 sysId@name-9=0x0000（名 he
  "BV_DoorElectPasseSideUDS": "0x0b1e", // 同组name-9 | BV_DoorElectPasseSideUDS_BaseSys | SYS_DATA 名字 'BV_DoorElectPasseSideUDS_BaseSys' @off=283936 flag=0 sysId@name-9=0x0000（名 he
  "BV_DoorElectRearDriveSideUDS": "0x0b1e", // 同组name-9 | BV_DoorElectRearDriveSideUDS_BaseSys | SYS_DATA 名字 'BV_DoorElectRearDriveSideUDS_BaseSys' @off=284179 flag=0 sysId@name-9=0x0000（
  "BV_DoorElectRearPasseSideUDS": "0x0b1e", // 同组name-9 | BV_DoorElectRearPasseSideUDS_BaseSys | SYS_DATA 名字 'BV_DoorElectRearPasseSideUDS_BaseSys' @off=284426 flag=0 sysId@name-9=0x0000（
  "BV_DriveMotorContrModulUDS": "0x0b01", // 同组name-9 | BV_DriveMotorContrModulUDS_BaseSys | SYS_DATA 名字 'BV_DriveMotorContrModulUDS_BaseSys' @off=284673 flag=0 sysId@name-9=0x0000（名 
  "BV_DriveMotorContrModulUDS_A01": "0x0b43", // 名字name-9 | BV_DriveMotorContrModulUDS_A01_BaseSys | SYS_DATA 名字 'BV_DriveMotorContrModulUDS_A01_BaseSys' @off=36217 flag=1 sysId@name-9=0x0B43
  "BV_ECM20_FSI": "0x0f01", // 名字name-9 | BV_ECM20_FSI_BaseSys | SYS_DATA 名字 'BV_ECM20_FSI_BaseSys' @off=216926 flag=1 sysId@name-9=0x0F01（名 hex 42 56 5f 4
  "BV_ECM30TFS": "0x0c01", // 名字name-9 | BV_ECM30TFS_BaseSys | SYS_DATA 名字 'BV_ECM30TFS_BaseSys' @off=44875 flag=2 sysId@name-9=0x0C01（名 hex 42 56 5f 45 
  "BV_ECM30TNF": "0x0b01", // 名字name-9 | BV_ECM30TNF_BaseSys | SYS_DATA 名字 'BV_ECM30TNF_BaseSys' @off=24442 flag=1 sysId@name-9=0x0B01（名 hex 42 56 5f 45 
  "BV_ECM30_GEN2_TNF": "0x0b01", // 同组name-9 | BV_ECM30_GEN2_TNF_BaseSys | SYS_DATA 名字 'BV_ECM30_GEN2_TNF_BaseSys' @off=24707 flag=0 sysId@name-9=0x6E000000（名 hex 42
  "BV_ECM36FSI": "0x0b01", // 同组name-9 | BV_ECM36FSI_BaseSys | SYS_DATA 名字 'BV_ECM36FSI_BaseSys' @off=25657 flag=0 sysId@name-9=0x2000000（名 hex 42 56 5f 
  "BV_ECM42TDI": "0x0b01", // 名字name-9 | BV_ECM42TDI_BaseSys | SYS_DATA 名字 'BV_ECM42TDI_BaseSys' @off=26700 flag=1 sysId@name-9=0x0B01（名 hex 42 56 5f 45 
  "BV_ERA_GLONASS": "0x0ba5", // 同组name-9 | BV_ERA_GLONASS_BaseSys | SYS_DATA 名字 'BV_ERA_GLONASS_BaseSys' @off=321304 flag=0 sysId@name-9=0x0000（名 hex 42 56 5f
  "BV_ElectAdjusSteerColumUDS": "0x0b36", // 同组name-9 | BV_ElectAdjusSteerColumUDS_BaseSys | SYS_DATA 名字 'BV_ElectAdjusSteerColumUDS_BaseSys' @off=285567 flag=0 sysId@name-9=0x0000（名 
  // BV_EnginContrModul1UDS 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 同组name-9 | BV_EnginContrModul1UDS_BaseSys | SYS_DATA 名字 'BV_EnginContrModul1UDS_BaseSys' @off=63834 flag=0 sysId@name-9=0x2E000000（名 h
  "BV_EnginContrModulMacanIII": "0x0b01", // 同组name-9 | BV_EnginContrModulMacanIII_BaseSys | SYS_DATA 名字 'BV_EnginContrModulMacanIII_BaseSys' @off=218597 flag=0 sysId@name-9=0x8C00000
  "BV_GatewUDS": "0x0b09", // 同组name-9 | BV_GatewUDS_BaseSys | SYS_DATA 名字 'BV_GatewUDS_BaseSys' @off=288380 flag=0 sysId@name-9=0x0000（名 hex 42 56 5f 47
  "BV_GearSelecContrModulUDS": "0x0c44", // 同组name-9 | 同组/DIR | 模块名 'BV_GearSelecContrModulUDS' 规范化 'bvgearseleccontrmoduluds' 在 SYS_DATA 名字表 3961 条全表检索零命
  "BV_GearShiftContrModulUDS": "0x0c44", // 同组name-9 | BV_GearShiftContrModulUDS_BaseSys | SYS_DATA 名字 'BV_GearShiftContrModulUDS_BaseSys' @off=288939 flag=0 sysId@name-9=0x0000（名 h
  "BV_InforContrUnit1PAGUDS": "0x0b46", // 同组name-9 | BV_InforContrUnit1PAGUDS_BaseSys | SYS_DATA 名字 'BV_InforContrUnit1PAGUDS_BaseSys' @off=232031 flag=0 sysId@name-9=0x5C000000（
  // BV_InforContrUnit1UDS 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | BV_InforContrUnit1UDS_BaseSys | SYS_DATA 名字 'BV_InforContrUnit1UDS_BaseSys' @off=36827 flag=2 sysId@name-9=0x0B46（名 hex 42
  // BV_InforContrUnit1UDSDesay 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 同组name-9 | BV_InforContrUnit1UDSDesay_BaseSys | SYS_DATA 名字 'BV_InforContrUnit1UDSDesay_BaseSys' @off=81423 flag=0 sysId@name-9=0x34000000
  "BV_InfotInterUDS": "0x0b46", // 同组name-9 | BV_InfotInterUDS_BaseSys | SYS_DATA 名字 'BV_InfotInterUDS_BaseSys' @off=298713 flag=0 sysId@name-9=0x0000（名 hex 42 56 
  "BV_LaneChangAssisUDS": "0x0f4d", // DIR行族 | BV_LaneChangAssisUDS_BaseSys | SYS_DATA 名字 'BV_LaneChangAssisUDS_BaseSys' @off=289982 flag=0 sysId@name-9=0x0000（名 hex 42
  "BV_LightContrLeft2UDS": "0x0e30", // 同组name-9 | BV_LightContrLeft2UDS_BaseSys | SYS_DATA 名字 'BV_LightContrLeft2UDS_BaseSys' @off=290222 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_LightContrLeftUDS": "0x0e30", // 同组name-9 | BV_LightContrLeftUDS_BaseSys | SYS_DATA 名字 'BV_LightContrLeftUDS_BaseSys' @off=290674 flag=0 sysId@name-9=0x0000（名 hex 42
  "BV_LightContrRight2UDS": "0x0e30", // 同组name-9 | BV_LightContrRight2UDS_BaseSys | SYS_DATA 名字 'BV_LightContrRight2UDS_BaseSys' @off=290906 flag=0 sysId@name-9=0x0000（名 hex 
  "BV_LightContrRightUDS": "0x0e30", // 同组name-9 | BV_LightContrRightUDS_BaseSys | SYS_DATA 名字 'BV_LightContrRightUDS_BaseSys' @off=291362 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_MediaPlayePosit1UDS": "0x0b80", // 名字name-9 | BV_MediaPlayePosit1UDS_BaseSys | SYS_DATA 名字 'BV_MediaPlayePosit1UDS_BaseSys' @off=39223 flag=1 sysId@name-9=0x0B80（名 hex 4
  "BV_MultiFunctSteerWheelContrModulUDS": "0x0b36", // 同组name-9 | 同组/DIR | 模块名 'BV_MultiFunctSteerWheelContrModulUDS' 规范化 'bvmultifunctsteerwheelcontrmoduluds' 在 SYS
  "BV_ParkiAssisUDS": "0x0b12", // 同组name-9 | BV_ParkiAssisUDS_BaseSys | SYS_DATA 名字 'BV_ParkiAssisUDS_BaseSys' @off=224692 flag=0 sysId@name-9=0x0000（名 hex 42 56 
  "BV_R4Evo4": "0x0c05", // 同组name-9 | BV_R4Evo4_BaseSys | SYS_DATA 名字 'BV_R4Evo4_BaseSys' @off=219046 flag=0 sysId@name-9=0x40000000（名 hex 42 56 5f 
  "BV_RealTopView2": "0x0f51", // 名字name-9 | BV_RealTopView2_BaseSys | SYS_DATA 名字 'BV_RealTopView2_BaseSys' @off=224157 flag=1 sysId@name-9=0x0F51（名 hex 42 56 5
  "BV_ReducContrModulPAGUDS": "0x0b35", // 同组name-9 | 同组/DIR | 模块名 'BV_ReducContrModulPAGUDS' 规范化 'bvreduccontrmodulpaguds' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "BV_ReducContrModulUDS": "0x0f56", // 名字name-9 | BV_ReducContrModulUDS_BaseSys | SYS_DATA 名字 'BV_ReducContrModulUDS_BaseSys' @off=219639 flag=1 sysId@name-9=0x0F56（名 hex 4
  "BV_RollContrSysteUDS": "0x0e2b", // 同组name-9 | BV_RollContrSysteUDS_BaseSys | SYS_DATA 名字 'BV_RollContrSysteUDS_BaseSys' @off=293279 flag=0 sysId@name-9=0x0000（名 hex 42
  "BV_SeatAdjusDriveSideUDS": "0x0b4c", // 同组name-9 | BV_SeatAdjusDriveSideUDS_BaseSys | SYS_DATA 名字 'BV_SeatAdjusDriveSideUDS_BaseSys' @off=293731 flag=0 sysId@name-9=0x0000（名 he
  "BV_SeatAdjusPasseSideUDS": "0x0b4c", // 同组name-9 | BV_SeatAdjusPasseSideUDS_BaseSys | SYS_DATA 名字 'BV_SeatAdjusPasseSideUDS_BaseSys' @off=293921 flag=0 sysId@name-9=0x0000（名 he
  "BV_SeatAdjusRearDriveSideUDS": "0x0b4c", // 同组name-9 | BV_SeatAdjusRearDriveSideUDS_BaseSys | SYS_DATA 名字 'BV_SeatAdjusRearDriveSideUDS_BaseSys' @off=294111 flag=0 sysId@name-9=0x0000（
  "BV_SeatAdjusRearPasseSideUDS": "0x0b4c", // 同组name-9 | BV_SeatAdjusRearPasseSideUDS_BaseSys | SYS_DATA 名字 'BV_SeatAdjusRearPasseSideUDS_BaseSys' @off=294305 flag=0 sysId@name-9=0x0000（
  // BV_SoundSysteUDS 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | BV_SoundSysteUDS_BaseSys | SYS_DATA 名字 'BV_SoundSysteUDS_BaseSys' @off=35573 flag=2 sysId@name-9=0x0B41（名 hex 42 56 5
  "BV_SteerAssisUDS": "0x0e45", // 同组name-9 | BV_SteerAssisUDS_BaseSys | SYS_DATA 名字 'BV_SteerAssisUDS_BaseSys' @off=294882 flag=0 sysId@name-9=0x0000（名 hex 42 56 
  "BV_SteerColumElectUDS": "0x0e45", // 同组name-9 | BV_SteerColumElectUDS_BaseSys | SYS_DATA 名字 'BV_SteerColumElectUDS_BaseSys' @off=295653 flag=0 sysId@name-9=0x0000（名 hex 4
  // BV_TVTunerUDS 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | BV_TVTunerUDS_BaseSys | SYS_DATA 名字 'BV_TVTunerUDS_BaseSys' @off=39723 flag=2 sysId@name-9=0x0B4B（名 hex 42 56 5f 5
  "BV_TirePressMonit1UDS": "0x0b37", // 同组name-9 | BV_TirePressMonit1UDS_BaseSys | SYS_DATA 名字 'BV_TirePressMonit1UDS_BaseSys' @off=296892 flag=0 sysId@name-9=0x0000（名 hex 4
  "BV_TrailFunctUDS": "0x0f54", // 名字name-9 | BV_TrailFunctUDS_BaseSys | SYS_DATA 名字 'BV_TrailFunctUDS_BaseSys' @off=42629 flag=1 sysId@name-9=0x0B54（名 hex 42 56 5
  "BV_TransContrModulUDS": "0x0b02", // 名字name-9 | BV_TransContrModulUDS_BaseSys | SYS_DATA 名字 'BV_TransContrModulUDS_BaseSys' @off=26932 flag=1 sysId@name-9=0x0B02（名 hex 42
  "BV_WaterContrUnitUDS": "0x0b07", // 同组name-9 | 同组/DIR | 模块名 'BV_WaterContrUnitUDS' 规范化 'bvwatercontrunituds' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "DME_SIMOS_30_TFSI": "0x0b01", // 同组name-9 | DME_SIMOS_30_TFSI_BaseSys | SYS_DATA 名字 'DME_SIMOS_30_TFSI_BaseSys' @off=25458 flag=0 sysId@name-9=0x84000000（名 hex 44
  "E1_EDC17": "0x0b01", // 同组name-9 | 同组/DIR | 模块名 'E1_EDC17' 规范化 'e1edc17' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_airbag": "0x0b04", // 同组name-9 | 同组/DIR | 模块名 'E1_airbag' 规范化 'e1airbag' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_bsg": "0x0b36", // 同组name-9 | 同组/DIR | 模块名 'E1_bsg' 规范化 'e1bsg' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_klima": "0x0b07", // 同组name-9 | 同组/DIR | 模块名 'E1_klima' 规范化 'e1klima' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_kombi": "0x0e08", // 同组name-9 | 同组/DIR | 模块名 'E1_kombi' 规范化 'e1kombi' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_lwr_links": "0x0e30", // 同组name-9 | 同组/DIR | 模块名 'E1_lwr_links' 规范化 'e1lwrlinks' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_lwr_neu": "0x0e30", // 同组name-9 | 同组/DIR | 模块名 'E1_lwr_neu' 规范化 'e1lwrneu' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_lwr_rechts": "0x0e30", // 同组name-9 | 同组/DIR | 模块名 'E1_lwr_rechts' 规范化 'e1lwrrechts' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_med91_me711": "0x0b01", // 同组name-9 | 同组/DIR | 模块名 'E1_med91_me711' 规范化 'e1med91me711' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_niveau": "0x0e13", // 同组name-9 | 同组/DIR | 模块名 'E1_niveau' 规范化 'e1niveau' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_bose": "0x0b41", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_bose' 规范化 'e1pcm2bose' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_cd_navi": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_cd_navi' 规范化 'e1pcm2cdnavi' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_cdc": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_cdc' 规范化 'e1pcm2cdc' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_dvd_navi": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_dvd_navi' 规范化 'e1pcm2dvdnavi' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_gw": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_gw' 规范化 'e1pcm2gw' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_mmi": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_mmi' 规范化 'e1pcm2mmi' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_satradio": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_satradio' 规范化 'e1pcm2satradio' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_sbs": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_sbs' 规范化 'e1pcm2sbs' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_sbs2": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_sbs2' 规范化 'e1pcm2sbs2' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_telefon": "0x0b46", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_telefon' 规范化 'e1pcm2telefon' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_pcm2_tvtuner": "0x0b4b", // 同组name-9 | 同组/DIR | 模块名 'E1_pcm2_tvtuner' 规范化 'e1pcm2tvtuner' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_sitzb": "0x0b4c", // 同组name-9 | 同组/DIR | 模块名 'E1_sitzb' 规范化 'e1sitzb' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_sitzf": "0x0b4c", // 同组name-9 | 同组/DIR | 模块名 'E1_sitzf' 规范化 'e1sitzf' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_swsg_links": "0x0e30", // 同组name-9 | 同组/DIR | 模块名 'E1_swsg_links' 规范化 'e1swsglinks' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_swsg_rechts": "0x0e30", // 同组name-9 | 同组/DIR | 模块名 'E1_swsg_rechts' 规范化 'e1swsgrechts' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "E1_tiptrnc": "0x0c02", // 同组name-9 | 同组/DIR | 模块名 'E1_tiptrnc' 规范化 'e1tiptrnc' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "EPS": "0x0b45", // 名字name-9→DIR代际 | EPS_BaseSys | SYS_DATA 名字 'EPS_BaseSys' @off=225521 flag=1 sysId@name-9=0x0F45（名 hex 45 50 53 5f 42 61 7
  // ERA_GLONASS 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | ERA_GLONASS_BaseSys | SYS_DATA 名字 'ERA_GLONASS_BaseSys' @off=37884 flag=1 sysId@name-9=0x0BA5（名 hex 45 52 41 5f
  // ERA_GLONASS_VFA 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 同组name-9 | ERA_GLONASS_VFA_BaseSys | SYS_DATA 名字 'ERA_GLONASS_VFA_BaseSys' @off=81084 flag=0 sysId@name-9=0x0000（名 hex 45 52 41
  "ESP_Colorado": "0x0b05", // 名字name-9 | ESP_Colorado_BaseSys | SYS_DATA 名字 'ESP_Colorado_BaseSys' @off=27483 flag=1 sysId@name-9=0x0B05（名 hex 45 53 50 5f
  "Heckklappe": "0x0b34", // 名字name-9 | Heckklappe_BaseSys | SYS_DATA 名字 'Heckklappe_BaseSys' @off=33534 flag=1 sysId@name-9=0x0B34（名 hex 48 65 63 6b 6
  // Hinterachslenkung 同值重复键已删除。 // 名字name-9 | Hinterachslenkung_BaseSys | SYS_DATA 名字 'Hinterachslenkung_BaseSys' @off=78789 flag=1 sysId@name-9=0x0E59（名 hex 48 69
  "Kombiinstrument": "0x0b08", // 名字name-9 | Kombiinstrument_BaseSys | SYS_DATA 名字 'Kombiinstrument_BaseSys' @off=28826 flag=1 sysId@name-9=0x0B08（名 hex 4b 6f 6d
  "Kompass": "0x0b49", // 名字name-9 | Kompass_BaseSys | SYS_DATA 名字 'Kompass_BaseSys' @off=37414 flag=1 sysId@name-9=0x0B49（名 hex 4b 6f 6d 70 61 7
  // Lenkstockschalter 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | Lenkstockschalter_BaseSys | SYS_DATA 名字 'Lenkstockschalter_BaseSys' @off=34089 flag=1 sysId@name-9=0x0B36（名 hex 4c 65
  // Lift_VA 同值重复键已删除。 // 名字name-9 | Lift_VA_BaseSys | SYS_DATA 名字 'Lift_VA_BaseSys' @off=79601 flag=1 sysId@name-9=0x0E5B（名 hex 4c 69 66 74 5f 5
  // Lift_VA_Gen2 同值重复键已删除。 // 同组name-9 | Lift_VA_Gen2_BaseSys | SYS_DATA 名字 'Lift_VA_Gen2_BaseSys' @off=79719 flag=0 sysId@name-9=0x0000（名 hex 4c 69 66 74
  // MED17_1_11 同值重复键已删除。 // 名字name-9 | MED17_1_11_BaseSys | SYS_DATA 名字 'MED17_1_11_BaseSys' @off=62460 flag=2 sysId@name-9=0x0E01（名 hex 4d 45 44 31 3
  // PASM_PADM 同值重复键已删除。 // 名字name-9 | PASM_PADM_BaseSys | SYS_DATA 名字 'PASM_PADM_BaseSys' @off=68794 flag=1 sysId@name-9=0x0E13（名 hex 50 41 53 4d 5f
  "PDCC": "0x0b2b", // 名字name-9 | PDCC_BaseSys | SYS_DATA 名字 'PDCC_BaseSys' @off=32631 flag=1 sysId@name-9=0x0B2B（名 hex 50 44 43 43 5f 42 6
  // PDCC_2 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9→DIR代际 | PDCC_2_BaseSys | SYS_DATA 名字 'PDCC_2_BaseSys' @off=73289 flag=1 sysId@name-9=0x0E2B（名 hex 50 44 43 43 5f 32
  "PSM": "0x0c05", // 名字name-9 | PSM_BaseSys | SYS_DATA 名字 'PSM_BaseSys' @off=45929 flag=1 sysId@name-9=0x0C05（名 hex 50 53 4d 5f 42 61 73
  "Quersperre": "0x0b53", // 名字name-9 | Quersperre_BaseSys | SYS_DATA 名字 'Quersperre_BaseSys' @off=42448 flag=1 sysId@name-9=0x0B53（名 hex 51 75 65 72 7
  // RDK3 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | RDK3_BaseSys | SYS_DATA 名字 'RDK3_BaseSys' @off=55284 flag=1 sysId@name-9=0x0C37（名 hex 52 44 4b 33 5f 42 6
  "Rueckfahrkamera": "0x0c51", // 名字name-9 | Rueckfahrkamera_BaseSys | SYS_DATA 名字 'Rueckfahrkamera_BaseSys' @off=41859 flag=1 sysId@name-9=0x0B51（名 hex 52 75 65
  // SWSG 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 同组name-9 | 同组/DIR | 模块名 'SWSG' 规范化 'swsg' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "SWSG_mit_AFS_ALWR": "0x0b2f", // 名字name-9 | SWSG_mit_AFS_ALWR_BaseSys | SYS_DATA 名字 'SWSG_mit_AFS_ALWR_BaseSys' @off=32876 flag=1 sysId@name-9=0x0B2F（名 hex 53 57 
  // Steering_Control_Unit 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9→DIR代际 | Steering_Control_Unit_BaseSys | SYS_DATA 名字 'Steering_Control_Unit_BaseSys' @off=76241 flag=1 sysId@name-9=0x0E45（名 hex 53
  // TVTuner 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // 名字name-9 | TVTuner_BaseSys | SYS_DATA 名字 'TVTuner_BaseSys' @off=39508 flag=1 sysId@name-9=0x0B4B（名 hex 54 56 54 75 6e 6
  // Verdeck_Synchronisation 同值重复键已删除。 // 名字name-9 | Verdeck_Synchronisation_BaseSys | SYS_DATA 名字 'Verdeck_Synchronisation_BaseSys' @off=72876 flag=1 sysId@name-9=0x0E27（名 hex
  // Verdeck_Targa 同值重复键已删除。 // 同组name-9 | Verdeck_Targa_BaseSys | SYS_DATA 名字 'Verdeck_Targa_BaseSys' @off=72993 flag=0 sysId@name-9=0x0000（名 hex 56 65 72 6
  "Zusatzheizung": "0x0b55", // 名字name-9 | Zusatzheizung_BaseSys | SYS_DATA 名字 'Zusatzheizung_BaseSys' @off=43065 flag=1 sysId@name-9=0x0B55（名 hex 5a 75 73 6
  // Zusatzinstrument 旧代值已移至 MODULE_TO_ECUID_LEGACY。 // DIR行族 | Zusatzinstrument_BaseSys | SYS_DATA 名字 'Zusatzinstrument_BaseSys' @off=31190 flag=0 sysId@name-9=0x0000（名 hex 5a 75 7
  "_9x7_bde": "0x0b01", // 同组name-9 | 同组/DIR | 模块名 '_9x7_bde' 规范化 '9x7bde' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_dme_me78": "0x0b01", // 同组name-9 | 同组/DIR | 模块名 '_9x7_dme_me78' 规范化 '9x7dmeme78' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_dme_me781": "0x0b01", // 同组name-9 | 同组/DIR | 模块名 '_9x7_dme_me781' 规范化 '9x7dmeme781' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_gateway": "0x0b09", // 同组name-9 | 同组/DIR | 模块名 '_9x7_gateway' 规范化 '9x7gateway' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_heck": "0x0b23", // 同组name-9 | 同组/DIR | 模块名 '_9x7_heck' 规范化 '9x7heck' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_klima": "0x0b07", // 同组name-9 | 同组/DIR | 模块名 '_9x7_klima' 规范化 '9x7klima' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_kombi": "0x0e08", // 同组name-9 | 同组/DIR | 模块名 '_9x7_kombi' 规范化 '9x7kombi' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_kurve": "0x0c05", // 同组name-9 | 同组/DIR | 模块名 '_9x7_kurve' 规范化 '9x7kurve' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_park": "0x0b12", // 同组name-9 | 同组/DIR | 模块名 '_9x7_park' 规范化 '9x7park' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_pdc": "0x0b12", // 同组name-9 | 同组/DIR | 模块名 '_9x7_pdc' 规范化 '9x7pdc' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_psm": "0x0c05", // 同组name-9 | 同组/DIR | 模块名 '_9x7_psm' 规范化 '9x7psm' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_targa": "0x0e27", // 同组name-9 | 同组/DIR | 模块名 '_9x7_targa' 规范化 '9x7targa' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_tiptrnc_987": "0x0c02", // 同组name-9 | 同组/DIR | 模块名 '_9x7_tiptrnc_987' 规范化 '9x7tiptrnc987' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_tiptrnc_997": "0x0c02", // 同组name-9 | 同组/DIR | 模块名 '_9x7_tiptrnc_997' 规范化 '9x7tiptrnc997' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_tiptrnc_C7": "0x0c02", // 同组name-9 | 同组/DIR | 模块名 '_9x7_tiptrnc_C7' 规范化 '9x7tiptrncc7' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_tuerb": "0x0b1e", // 同组name-9 | 同组/DIR | 模块名 '_9x7_tuerb' 规范化 '9x7tuerb' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_tuerf": "0x0b1e", // 同组name-9 | 同组/DIR | 模块名 '_9x7_tuerf' 规范化 '9x7tuerf' 在 SYS_DATA 名字表 3961 条全表检索零命中
  "_9x7_uhr": "0x0b1d", // DIR行族 | 同组/DIR | 模块名 '_9x7_uhr' 规范化 '9x7uhr' 在 SYS_DATA 名字表 3961 条全表检索零命中
};

// 未定案/未选车型的旧代回退值。与 981 主映射分开，避免同名键覆盖。
export const MODULE_TO_ECUID_LEGACY = {
  "Allrad": "0x0b35",
  "BV_ActuaForStrucBorneSoundUDS": "0x0b57",
  "BV_EnginContrModul1UDS": "0x0b01",
  "BV_InforContrUnit1UDS": "0x0b46",
  "BV_InforContrUnit1UDSDesay": "0x0b46",
  "BV_SoundSysteUDS": "0x0b41",
  "BV_TVTunerUDS": "0x0b4b",
  "ERA_GLONASS": "0x0ba5",
  "ERA_GLONASS_VFA": "0x0ba5",
  "Lenkstockschalter": "0x0b36",
  "PDCC_2": "0x0b2b",
  "RDK3": "0x0c37",
  "SWSG": "0x0e30",
  "Steering_Control_Unit": "0x0b45",
  "TVTuner": "0x0b4b",
  "Zusatzinstrument": "0x0b1d",
};
export const SYSTEM_TO_ECUID = {
  // 981 菜单标签 → 0x0E 代 sysId（2026-11-10 换表，同 MODULE_TO_ECUID 证据链）
  //   标签取「系统直名模块」（如 左/中/右前照灯 → SCHEINWERFER 0x0e58），
  //   LED/SWSG 变体经 sys.modules → MODULE_TO_ECUID 解析（app.js 兜底链）。
  //   旧 0x0B 值见 git 历史与本文件顶部注释。
  "安全气囊": "0x0e04",
  "网关": "0x0e09",
  "ECM/DME(发动机控制模块)": "0x0e01",
  "Tiptronic 变速器控制": "0x0e02",
  "选档杆": "0x0e44",
  "IC(仪表)": "0x0e08",
  "转向盘电子设备": "0x0e36",
  "附加仪表 - 时钟": "0x0e1d",
  "PCM/CDR（通信管理/CD、收音机）": "0x0e46",
  "电视调谐器": "0x0e4b",
  "外部放大器": "0x0e41",
  "AC(空调系统)": "0x0e07",
  "驻车辅助系统": "0x0e12",
  "驻车制动器": "0x0e32",
  "轮胎压力监控 （TPM）": "0x0e37",
  "水平高度控制/PASM": "0x0e13",
  "EPS(电动助力转向系统)": "0x0e45",
  "ESP/PSM(电控稳定系统)": "0x0e05",
  "前端电子设备": "0x0e20",
  "后端电子设备": "0x0e23",
  "左侧前照灯": "0x0e58",
  "中央前照灯": "0x0e58",
  "右前照灯": "0x0e58",
  "驾驶员侧座椅存储器": "0x0e4c",
  "乘客侧座椅存储器": "0x0e4e",
  "驾驶员侧车门": "0x0e1e",
  "乘客侧车门": "0x0e1f",
  "可折叠顶篷": "0x0e27",
  "CCS/ACC(巡航控制系统)": "0x0e40",
  "前摄像头": "0x0e4a",
  "倒车摄像头": "0x0e51",
  "调音器": "0x0e57",
  "车道变换辅助系统，右侧（主设备）": "0x0f4d",
  "车道变换辅助系统，左侧（从动设备）": "0x0f4d",
  "紧急呼叫系统 （ERA Glonass）": "0x0ea5"
};
