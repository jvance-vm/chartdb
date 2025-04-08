<p align="center">
  <a href="https://chartdb.io#gh-light-mode-only">
    <img src="https://github.com/jvance-vm/thip-efs/blob/main/home-banner1.png" alt="ChartDB">
  </a>
  <a href="https://chartdb.io##gh-dark-mode-only">
    <img src="https://github.com/jvance-vm/thip-efs/blob/main/home-banner1.png" alt="ChartDB">
  </a>
  <br>
</p>

---

<!-- <p align="center">
  <img width='700px' src="./public/chartdb.png">
</p> -->

# THIP EFS – Email Filing System

The **THIP Email Filing System (EFS)** is a Power Automate-based automation designed to streamline the filing of client-related emails into **NetDocuments**. It parses inbound emails, extracts metadata such as the **MatterNumber**, and files them automatically into the appropriate workspace and folder within NetDocuments using their API connector.

This system reduces manual overhead, ensures consistency, and improves the legal team’s ability to track client correspondence.

<h3 align="center">
  <a href="https://github.com/jvance-vm/thip-efs/edit/main/README.md#-system-overview">Community</a>  &bull;
  <a href="https://github.com/jvance-vm/thip-efs/edit/main/README.md#%E2%84%B9%EF%B8%8F-special-functionality">Website</a>  &bull;
  <a href="https://github.com/jvance-vm/thip-efs/edit/main/README.md#-versioning--releases">Examples</a>  &bull;
  <a href="https://github.com/jvance-vm/thip-efs/edit/main/README.md#-community--support">Demo</a>
</h3>

---

## 📦 System Overview

### 🛠 Key Components

- **Power Automate Main Flow**:  
  - Flow Page: [NetDocs - File Emails Automatically v1.71](https://make.powerautomate.com/environments/Default-0bc5ac66-4def-4d50-af7f-775338be354a/flows/9f5a51e2-54d3-4884-aa25-4f7734b7e83c/details?v3=false)
  - Triggered on new email arrivals in the `th.mail@thip.law` monitored Outlook mailbox.
  - Parses subject lines to extract valid `MatterNumbers` using strict format validation.
    - Multiple `MatterNumbers` can be detected and iterated through.
    - If any `MatterNumbers` fail validation, the rest are still processed.  
  <!-- - Validates MatterNumbers against a live **Lookup Table (LUT)** stored in Excel Online (OneDrive). -->
  - **For each valid `MatterNumber`**, NetDocuments API is called to:
    - Locate appropriate workspace/folder
    - File the email
    - For non `@thip.law` senders
      - Each email attachment is saved as a standalone file
        - Image files are ignored
  - Logs sent email, marks as "complete" & moves to 'Filed' folder.

- **External Data-Sources**:
  - ✅ **Excel Online (OneDrive)**:
    - Three connected Lookup Tables:
      - [Country Code & Email Domain LUT](https://thomashorstemeyer-my.sharepoint.com/:x:/r/personal/th_mail_thip_law/Documents/THIP-EFS-Country-Codes.xlsx?d=w83956289837f46ffaa72f5c17b7312e2&csf=1&web=1&e=d9Eqgo) (list of ccTLDs e.g. `.fr` `.de` and end-of-email-domain extensions e.g. `spoor.com` for Foreign Associate (FA) logic)
      - [NetDocs Username / Email LUT](https://thomashorstemeyer-my.sharepoint.com/:x:/r/personal/th_mail_thip_law/Documents/Netdocs-Usernames-vs-Email-Addresses_Feb2025.xlsx?d=w3797ca97bed0485b92911ea4df4565fe&csf=1&web=1&e=J6oJ0Y) (matches internal email addresses to NetDocs usernames for dynamic 'AUTHOR' & 'TYPIST' value population)
      - [Emails Sent Log](https://thomashorstemeyer-my.sharepoint.com/:x:/r/personal/th_mail_thip_law/Documents/Netdocs-Usernames-vs-Email-Addresses_Feb2025.xlsx?d=w3797ca97bed0485b92911ea4df4565fe&csf=1&web=1&e=J6oJ0Y) (tracks all successfully filed emails)

- **Retry/Manual Flow (Optional)**:  
  - A stand-alone Flow for batch-processing un-caught emails. Flow Page: [NetDocs - File Emails Automatically v1.71 Manual](https://make.powerautomate.com/environments/Default-0bc5ac66-4def-4d50-af7f-775338be354a/flows/3c67c9aa-41cf-4248-bcfa-32b4551f9388/details?v3=false)
  - Allows for manual triggering (e.g., “retry last 30 unprocessed emails”) in case of NetDocuments outages.
  - Designed to prevent data loss or test new functionality.

---

## ℹ️ Special Functionality

### **Attachment Saving Routine**
- By default, email attachments are always retained in the original saved email in NetDocs.
- If email ***not*** from a `@thip.law` email address:
  - A ***separate copy*** of each email attachment is stored in ***each `MatterNumber` in subject***.
  - Image files are ignored. 
    - Includes `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.tiff` file types.
    - Includes files missing a file-type extension.
    - The code filtering the attachments array (Power Automate Expression Language):
      ```
      @and(
          contains(item()?['Name'], '.'), 
          not(equals(last(split(item()?['Name'], '.')), '')), 
          not(contains('jpg,jpeg,png,gif,bmp,tiff', last(split(item()?['Name'], '.'))))
      )
      ```

### **'Client Files' or 'Litigation' Routing**
- If `MatterNumbers.Group2` starts with a 7, e.g. XXXXXX-**X**XXX > file emails & attachments in 'Ligitation' Cabinet.
- Otherwise, file emails & attachments in 'Client Files' Cabinet.


### **'AUTHOR' & 'TYPIST' Field Population**
<p><img src="https://github.com/jvance-vm/thip-efs/blob/main/THIP-EFS-AUTHOR-TYPIST-Logic.png" width="700px"></p>

- Dynamically populates AUTHOR & TYPIST fields based on internal, domestic inbound, and foreign inbound logic.
- See flowchart above for more specifics, or [view here](https://github.com/jvance-vm/thip-efs/blob/main/THIP-EFS-AUTHOR-TYPIST-Logic.png).

---

<!-- ## 🔄 Versioning & Releases

The EFS is versioned using a semantic system (e.g. `v1.6.1`, `v1.7.0`). Each version represents an update to logic, error handling, UI tweaks, or system behavior. A full changelog is maintained in the `CHANGELOG.md`.

## Try it on our website

1. Go to [ChartDB.io](https://chartdb.io?ref=github_readme_2)
2. Click "Go to app"
3. Choose the database that you are using.
4. Take the magic query and run it in your database.
5. Copy and paste the resulting JSON set into ChartDB.
6. Enjoy Viewing & Editing!

## 💚 Community & Support

- [Discord](https://discord.gg/QeFwyWSKwC) (For live discussion with the community and the ChartDB team)
- [GitHub Issues](https://github.com/chartdb/chartdb/issues) (For any bugs and errors you encounter using ChartDB)
- [Twitter](https://x.com/chartdb_io) (Get news fast)
 -->
