import UIKit
import Capacitor

/// 系统竖栏导航（UITabBarController + UINavigationController bar items + UITab）。
///
/// 核心设计（对齐 iOS 27.1 竖栏 API）：
///   · 竖栏同时渲染「导航/工具栏 bar items」和「tab bar items」
///     （UINavigationItem.verticalBarCompressionBehavior 控制压缩顺序）
///   · action 按钮（返回/搜索/日志）= UIBarButtonItem 独立按钮
///     —— 不是 tab，天然不切页、不打断 WebView 当前操作
///   · 导航 tab（首页/选车）= UITab，负责切页
///   · 竖栏中 action 按钮在上、tab 在下，视觉上两个独立区域
///
/// UITabGroup.sidebarActions 不用：它只进 sidebar 模式且渲染在 tabs 之后，
/// 且 root 单 group 会把 tab bar 隐藏（2026-11-01 踩过）。
@available(iOS 18.0, *)
class SidebarNav: UITabBarController, UITabBarControllerDelegate {

    private let webHost: UIViewController
    private weak var glassRail: GlassRailPlugin?
    /// 各 tab 导航栏上的返回按钮（同步启用/禁用状态）
    private var backItems: [UIBarButtonItem] = []

    init(webHost: UIViewController, glassRail: GlassRailPlugin?) {
        self.webHost = webHost
        self.glassRail = glassRail
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        mode = .tabBar
        delegate = self
        webHost.loadViewIfNeeded()

        // 导航 tab（切页）
        let homeTab = UITab(title: "首页", image: UIImage(systemName: "house"), identifier: "home") { [weak self] _ in
            return self?.makeContentVC(for: "home") ?? UIViewController()
        }
        homeTab.preferredPlacement = .pinned
        homeTab.accessibilityIdentifier = "tab-home"

        let selectTab = UITab(title: "选车", image: UIImage(systemName: "car"), identifier: "select") { [weak self] _ in
            return self?.makeContentVC(for: "select") ?? UIViewController()
        }
        selectTab.preferredPlacement = .pinned
        selectTab.accessibilityIdentifier = "tab-select"

        tabs = [homeTab, selectTab]
        selectedTab = homeTab

        glassRail?.onActiveChanged = { [weak self] id in
            // 防御性主线程归位：插件回调可能来自 GCD 工作线程（2026-11-04 闪退教训）
            DispatchQueue.main.async { [weak self] in self?.setSelectedTab(id) }
        }
        glassRail?.onCanGoBackChanged = { [weak self] canGoBack in
            DispatchQueue.main.async { [weak self] in
                self?.backItems.forEach { $0.isEnabled = canGoBack }
            }
        }

        let app = UITabBarAppearance()
        app.stackedLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: UIColor.white.withAlphaComponent(0.70),
            .font: UIFont.systemFont(ofSize: 10, weight: .medium),
        ]
        app.stackedLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: UIColor.white,
            .font: UIFont.systemFont(ofSize: 10, weight: .semibold),
        ]
        app.stackedLayoutAppearance.normal.iconColor = UIColor.white.withAlphaComponent(0.70)
        app.stackedLayoutAppearance.selected.iconColor = .white
        tabBar.standardAppearance = app
        tabBar.scrollEdgeAppearance = app
    }

    private func makeContentVC(for tabId: String) -> UIViewController {
        let vc = TabContentVC(tabId: tabId, hostVC: webHost)
        vc.onShow = { [weak self] id in self?.notifyWeb(id) }
        // action 按钮挂在导航栏 item 上 → 竖栏把 bar items 和 tab items 一起渲染
        vc.navigationItem.rightBarButtonItems = makeActionItems()
        if #available(iOS 27.1, *) {
            // 空间不足时先压缩 tab，保 bar items 可见
            vc.navigationItem.verticalBarCompressionBehavior = .prefersBarItems
        }
        return UINavigationController(rootViewController: vc)
    }

    /// 三个独立 action 按钮（UIAction：不切页、不打断操作）
    private func makeActionItems() -> [UIBarButtonItem] {
        let back = UIBarButtonItem(primaryAction: UIAction(title: "返回", image: UIImage(systemName: "chevron.left")) { [weak self] _ in
            self?.notifyWeb("back")
        })
        back.isEnabled = glassRail?.canGoBack ?? false
        back.accessibilityIdentifier = "act-back"
        backItems.append(back)

        let search = UIBarButtonItem(primaryAction: UIAction(title: "搜索", image: UIImage(systemName: "magnifyingglass")) { [weak self] _ in
            self?.notifyWeb("search")
        })
        search.accessibilityIdentifier = "act-search"
        let log = UIBarButtonItem(primaryAction: UIAction(title: "日志", image: UIImage(systemName: "doc.text")) { [weak self] _ in
            self?.notifyWeb("log")
        })
        log.accessibilityIdentifier = "act-log"
        // 竖栏中 trailing 侧 bar items 自上而下按数组倒序渲染，倒序传入 → 返回/搜索/日志
        return [log, search, back]
    }

    private func notifyWeb(_ tabId: String) {
        let js = "window.APXRail && window.APXRail.select('\(tabId)')"
        (webHost as? CAPBridgeViewController)?.bridge?.webView?
            .evaluateJavaScript(js, completionHandler: nil)
        glassRail?.emitSelect(tabId)
    }

    func setSelectedTab(_ tabId: String) {
        // action id（back/search/log）不在 tabs 里，自然 no-op
        guard let tab = tabs.first(where: { $0.identifier == tabId }) else { return }
        selectedTab = tab
    }

    // MARK: - UITabBarControllerDelegate

    func tabBarController(_ tabBarController: UITabBarController, didSelect tab: UITab) {
        notifyWeb(tab.identifier ?? "")
    }
}

/// 轻量容器 VC：承载共享 WebView（reparent 模式）
@available(iOS 18.0, *)
class TabContentVC: UIViewController {
    let tabId: String
    private weak var hostVC: UIViewController?
    var onShow: ((String) -> Void)?

    init(tabId: String, hostVC: UIViewController) {
        self.tabId = tabId
        self.hostVC = hostVC
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.06, green: 0.07, blue: 0.09, alpha: 1.0)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        embedHost()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        onShow?(tabId)
    }

    private func embedHost() {
        guard let host = hostVC, let hostView = host.view else { return }
        if host.parent != nil {
            host.willMove(toParent: nil)
            hostView.removeFromSuperview()
            host.removeFromParent()
        }
        host.willMove(toParent: self)
        hostView.frame = view.bounds
        hostView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(hostView)
        host.didMove(toParent: self)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        hostVC?.view.frame = view.bounds
    }
}
