// Throwaway A01 experiment. Operates only this process's offscreen test window.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Forms;

class Program {
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle, IntPtr device, uint flags);
    [STAThread] static int Main(string[] args) {
        if (args.Length != 1) return 2;
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        using var window = new Form { Text = "RainyDays A01 fixture", ShowInTaskbar = false,
            StartPosition = FormStartPosition.Manual, Location = new Point(-2000, -2000), Size = new Size(360, 180) };
        var input = new TextBox { AccessibleName = "Probe input", Location = new Point(15, 15), Width = 250 };
        var apply = new Button { AccessibleName = "Probe apply", Text = "Apply", Location = new Point(15, 60) };
        var applied = false;
        apply.Click += (_, _) => applied = true;
        window.Controls.AddRange(new Control[] { input, apply });
        var exit = 1;
        window.Shown += (_, _) => {
            var handle = window.Handle;
            // UIA client calls run off the target UI thread, while its message pump remains live.
            _ = Task.Run(() => {
                try {
                    var root = AutomationElement.FromHandle(handle);
                    var entry = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "Probe input"));
                    var button = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "Probe apply"));
                    ((ValuePattern)entry.GetCurrentPattern(ValuePattern.Pattern)).SetValue("RainyDays 中文");
                    ((InvokePattern)button.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                    window.BeginInvoke(new Action(() => {
                        try {
                            using var bitmap = new Bitmap(window.Width, window.Height);
                            using var graphics = Graphics.FromImage(bitmap);
                            var dc = graphics.GetHdc();
                            bool captured;
                            try { captured = PrintWindow(handle, dc, 2); }
                            finally { graphics.ReleaseHdc(dc); }
                            bitmap.Save(args[0], ImageFormat.Png);
                            var elevated = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
                            exit = captured && applied && input.Text == "RainyDays 中文" ? 0 : 1;
                            Console.WriteLine(JsonSerializer.Serialize(new { uiaObserved = entry != null && button != null,
                                value = input.Text, invoked = applied, captured, width = bitmap.Width, height = bitmap.Height,
                                dpi = window.DeviceDpi, elevated, onlyOwnWindow = true }));
                        } catch (Exception error) { Console.Error.WriteLine(error); }
                        finally { window.Close(); }
                    }));
                } catch (Exception error) { Console.Error.WriteLine(error); window.BeginInvoke(new Action(window.Close)); }
            });
        };
        Application.Run(window);
        return exit;
    }
}
