import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)

        // 创建 Capacitor WebView 宿主
        let webHost = MfiBridgeViewController()
        webHost.loadViewIfNeeded()

        // ★ 2026-10-31：Duo（有系统竖栏的设备）用原生 UITabBarController 侧栏。
        //   其他设备保持网页导航，零改动。
        if #available(iOS 18.0, *), Self.hasVerticalBar(windowScene) {
            let sidebarNav = SidebarNav(webHost: webHost, glassRail: webHost.glassRailPlugin)
            window?.rootViewController = sidebarNav
            if let plugin = webHost.glassRailPlugin {
                plugin.onActiveChanged = { [weak sidebarNav] id in
                    sidebarNav?.setSelectedTab(id)
                }
            }
        } else {
            window?.rootViewController = webHost
        }
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// 设备是否有系统竖栏（iPhone Duo 右侧 vertical bar）
    static func hasVerticalBar(_ scene: UIWindowScene) -> Bool {
        if #available(iOS 27.1, *) {
            return scene.traitCollection.verticalBarEdge != .unspecified
        }
        return false
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// CAPBridgeViewController 子类：桥在 viewDidLoad 才创建，在此注册 app 内 MFi 插件
/// （cap sync 只登记 npm 插件且会重写 packageClassList，手动条目必须走运行时注册；
///   注意 bridge 是懒创建——SceneDelegate 里注册为时过早，2026-10 真机踩过）
class MfiBridgeViewController: CAPBridgeViewController {
    private(set) var glassRailPlugin: GlassRailPlugin?
    private var glassRailRegistered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        bridge?.registerPluginType(MfiSerialPlugin.self)
        registerGlassRail()
    }

    /// GlassRail 系统侧栏桥接插件 —— 只在有竖栏的设备注册
    private func registerGlassRail() {
        guard !glassRailRegistered, let bridge = bridge else { return }
        if #available(iOS 27.1, *) {
            guard traitCollection.verticalBarEdge != .unspecified else { return }
        } else {
            return
        }
        let plugin = GlassRailPlugin()
        bridge.registerPluginInstance(plugin)
        glassRailPlugin = plugin
        glassRailRegistered = true
    }
}
