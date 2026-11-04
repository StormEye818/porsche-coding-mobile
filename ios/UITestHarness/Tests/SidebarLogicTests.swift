import XCTest

/// 竖栏操作逻辑测试（无头模拟器可跑，挂已安装的 cn.bigmiao.porschecoder）。
///
/// 验收点（对齐 2026-11-01 用户要求）：
///   1. action 按钮（返回/搜索/日志）是独立按钮 —— 点按不切页、不打断 WebView
///   2. 导航 tab（首页/选车）切页且选中态互斥
///   3. 全程 WebView 存活（不黑屏）
final class SidebarLogicTests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "cn.bigmiao.porschecoder")
        app.launch()
    }

    // MARK: - 元素定位（优先 accessibilityIdentifier，回退 label）

    private func item(_ id: String, _ label: String) -> XCUIElement {
        let byId = app.descendants(matching: .any).matching(identifier: id).firstMatch
        if byId.exists { return byId }
        return app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private var homeTab: XCUIElement { item("tab-home", "首页") }
    private var selectTab: XCUIElement { item("tab-select", "选车") }
    private var backButton: XCUIElement { item("act-back", "返回") }
    private var searchButton: XCUIElement { item("act-search", "搜索") }
    private var logButton: XCUIElement { item("act-log", "日志") }

    private func waitForChrome(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertTrue(homeTab.waitForExistence(timeout: 15), "首页 tab 未出现\n\(app.debugDescription)", file: file, line: line)
        XCTAssertTrue(selectTab.waitForExistence(timeout: 5), "选车 tab 未出现", file: file, line: line)
        XCTAssertTrue(searchButton.waitForExistence(timeout: 5), "搜索按钮未出现", file: file, line: line)
        XCTAssertTrue(logButton.waitForExistence(timeout: 5), "日志按钮未出现", file: file, line: line)
        XCTAssertTrue(backButton.waitForExistence(timeout: 5), "返回按钮未出现", file: file, line: line)
    }

    /// WebView 存活检查：网页头部文字还在 = 没黑屏
    private func assertWebAlive(_ context: String, file: StaticString = #filePath, line: UInt = #line) {
        let title = app.staticTexts["Porsche Coder"]
        XCTAssertTrue(title.exists, "\(context)：WebView 疑似黑屏/丢失\n\(app.debugDescription)", file: file, line: line)
    }

    private func settle(_ seconds: Double = 0.8) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    // MARK: - 用例

    /// 诊断用：打印 AX 树，定位失败时先跑这个
    func testDumpAXTree() throws {
        try waitForChrome()
        print("=== AX TREE ===\n\(app.debugDescription)\n=== END ===")
    }

    /// 三个 action 按钮不切页、不打断 WebView
    func testActionButtonsDoNotSwitchTabs() throws {
        try waitForChrome()
        XCTAssertTrue(homeTab.isSelected, "初始应选中首页\n\(app.debugDescription)")

        searchButton.tap()
        settle()
        XCTAssertTrue(homeTab.isSelected, "点「搜索」后不应切走首页")
        assertWebAlive("点搜索后")

        logButton.tap()
        settle()
        XCTAssertTrue(homeTab.isSelected, "点「日志」后不应切走首页")
        assertWebAlive("点日志后")

        // 返回初始为禁用（网页历史为空）；若已启用，点了也不应切页
        if backButton.isEnabled {
            backButton.tap()
            settle()
            XCTAssertTrue(homeTab.isSelected, "点「返回」后不应切走首页")
        }
        assertWebAlive("点返回后")
    }

    /// 导航 tab 切页 + 选中态互斥
    func testNavTabsSwitch() throws {
        try waitForChrome()

        selectTab.tap()
        settle()
        XCTAssertTrue(selectTab.isSelected, "点「选车」后应选中选车\n\(app.debugDescription)")
        XCTAssertFalse(homeTab.isSelected, "首页应失选")
        assertWebAlive("切到选车后")

        homeTab.tap()
        settle()
        XCTAssertTrue(homeTab.isSelected, "点「首页」后应选中首页\n\(app.debugDescription)")
        XCTAssertFalse(selectTab.isSelected, "选车应失选")
        assertWebAlive("切回首页后")
    }

    /// 在选车页点 action 同样不切页（防止只在首页生效）
    func testActionButtonsOnSelectTabStillNoSwitch() throws {
        try waitForChrome()

        selectTab.tap()
        settle()
        XCTAssertTrue(selectTab.isSelected, "前置：应先切到选车")

        searchButton.tap()
        settle()
        XCTAssertTrue(selectTab.isSelected, "在选车页点「搜索」不应切页")
        assertWebAlive("选车页点搜索后")

        logButton.tap()
        settle()
        XCTAssertTrue(selectTab.isSelected, "在选车页点「日志」不应切页")
        assertWebAlive("选车页点日志后")
    }

    /// 返回键使能链路：网页栈有历史 → 点亮；退栈 → 复灰。
    /// 回归 2026-11-01 真机「返回键一直灰」：web 用 window.GlassRail（不存在）
    /// 调插件，上报被静默跳过；已改 registerPlugin('GlassRail')。
    func testBackButtonEnablesAfterWebNavigation() throws {
        try waitForChrome()
        XCTAssertFalse(backButton.isEnabled, "初始网页无历史，返回应禁用")

        // 网页里往深处点一级（首页「手动选择」→ 车系组列表，栈 +1）
        let manual = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "手动选择")).firstMatch
        XCTAssertTrue(manual.waitForExistence(timeout: 10), "网页「手动选择」未找到\n\(app.debugDescription)")
        manual.tap()

        let enabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: backButton)
        XCTAssertEqual(XCTWaiter().wait(for: [enabled], timeout: 6), .completed,
                       "网页有历史后返回键应点亮")

        // 点返回 → 退一级 → 复灰
        backButton.tap()
        let disabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == false"), object: backButton)
        XCTAssertEqual(XCTWaiter().wait(for: [disabled], timeout: 6), .completed,
                       "退栈后返回键应恢复禁用")
    }
}

// MARK: - 闪退回归：模拟模式 → 进模块 → 设码 → 规则编码
/// 回归 2026-11-04 真机 7 连崩（EXC_BREAKPOINT @ UIBarButtonItem.isEnabled 后台线程）。
final class SimModeCrashRegressionTests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "cn.bigmiao.porschecoder")
        app.launch()
    }

    private func settle(_ seconds: Double = 1.2) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func find(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// 闪退回归 + 模拟模式零提问体感：
    /// 模拟模式 → 车型自动识别（免确认）→ 系统 → AC → 设码 → 规则编码，
    /// 全程无弹窗、app 存活。
    /// 回归 2026-11-04 真机 7 连崩（EXC_BREAKPOINT @ UIBarButtonItem.isEnabled
    /// 后台线程改 UI）与「进模块手动选变体」两坑。
    func testSimModeRuleCodingFlow() throws {
        let sim = find("模拟模式")
        XCTAssertTrue(sim.waitForExistence(timeout: 15), "模拟模式按钮未找到\n\(app.debugDescription)")
        sim.tap()

        // ① 模拟车自动进入：识别车型、零弹窗
        XCTAssertTrue(find("退出模拟").waitForExistence(timeout: 8), "模拟模式未开启\n\(app.debugDescription)")
        XCTAssertTrue(app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS '991'")).firstMatch
            .waitForExistence(timeout: 10), "模拟车未自动识别车型\n\(app.debugDescription)")
        XCTAssertEqual(app.alerts.count, 0, "模拟车自动进入不该弹窗\n\(app.debugDescription)")

        // ② 进系统选择 → 进 AC 模块（不该弹变体选择）
        XCTAssertTrue(find("系统选择").waitForExistence(timeout: 8), "系统选择未出现")
        find("系统选择").tap()
        let ac = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS '空调'")).firstMatch
        XCTAssertTrue(ac.waitForExistence(timeout: 10), "AC 系统未找到\n\(app.debugDescription)")
        ac.tap()
        settle(3.0)
        XCTAssertEqual(app.alerts.count, 0, "进模块不该弹变体选择（参考诊断仪体感：零提问）\n\(app.debugDescription)")

        // ③ 设码 → 规则编码（真机必闪退点）
        let coding = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS '设码'")).firstMatch
        XCTAssertTrue(coding.waitForExistence(timeout: 8), "设码入口未找到\n\(app.debugDescription)")
        coding.tap()
        settle(2.5)
        let rule = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS '规则编码'")).firstMatch
        XCTAssertTrue(rule.waitForExistence(timeout: 8), "规则编码入口未找到\n\(app.debugDescription)")
        rule.tap()
        settle(2.5)

        XCTAssertTrue(app.state == .runningForeground, "app 不在前台 —— 闪退了！")
        XCTAssertEqual(app.alerts.count, 0, "规则编码页不该弹窗\n\(app.debugDescription)")
        XCTAssertTrue(app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS '设码值'")).firstMatch.exists,
            "规则编码内容未渲染\n\(app.debugDescription)")
    }
}
