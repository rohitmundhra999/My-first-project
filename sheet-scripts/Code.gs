

function checkAndStamp() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getActiveSheet();
  var sheetName = sheets.getName();
  var sheet = ss.getSheetByName(sheetName);
  var data = sheets.getRange('I:I').getValues();
  var count = 0;
 
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] !== '') {
      count++;
    }
  }
 
  var y = count+3;
  while (y <= 18000) {
    var dataH = sheets.getRange("I" + y).getValue();
    if (!dataH) {
      var dataIII = sheets.getRange("J" + y).getValue();
      if (!dataIII) {
        break;
      } else {
          var dataII = sheets.getRange("J" + y).getValue();
          if (dataII == "Rejected") {
          } else {
              var dataJ = sheets.getRange("K" + y).getValue();
              var dataK = sheets.getRange("L" + y).getValue();
              if (dataJ && dataK) {
                  var dataI = sheets.getRange("J" + y).getValue();
                  if (dataI == "Approved") {
                  sheets.getRange("I" + y).setValue(new Date());
                  } else {
                    break;
              }
              }
          }
      }
    }
    y++;
  }
}


function copyDataToDoc() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert("Are you sure you want to proceed making the PDF and updating details?", ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;


  var html = HtmlService.createHtmlOutput('<div style="border: 1px solid black; width: 100%; height: 20px;"><div id="progress" style="background-color: green; height: 50%; width: 0%;"></div></div>');
  SpreadsheetApp.getUi().showModalDialog(html, 'Updating P.O details. Please wait...');


  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("P.O");
  var data = sheet.getRange("Y24:AE54").getValues();
  var data2 = sheet.getRange("Y12:Z13").getValues();


  var vendorName = sheet.getRange("J15").getValues();
  var vendorPhone = sheet.getRange("J17").getValues();
  var unitPhone = sheet.getRange("Q19").getValues();
  var gSTNumb = sheet.getRange("P21").getValues();
  var poDate = sheet.getRange("S8").getValues();    
  var poNumber = sheet.getRange("S9").getValues();
  var subT = sheet.getRange("T55").getValues();  
  var shipping = sheet.getRange("T57").getValues();
  var oTher = sheet.getRange("T58").getValues();
  var grandT = sheet.getRange("T59").getValues();
  var addNotes = sheet.getRange("J56").getValues();
  var unitName1 = sheet.getRange("Q12").getValues();
  var unitName2 = sheet.getRange("Q16").getValues();
  var address1 = sheet.getRange("Q13").getValues();
  var address2 = sheet.getRange("Q17").getValues();
  var payMent1 = sheet.getRange("L59").getValues();
  var payMent2 = (payMent1 * 100).toFixed(2) + "%";
  var dateTime1 = sheet.getRange("L58").getValues();
  var vendorName2 = sheet.getRange("J15").getValues();


  var doc = DriveApp.getFileById("1Y2WXkxZmseD2df0pQ_bueQgvjy3TrklMUK8oe4WvOj8");
  var tempFolder = DriveApp.getFolderById("1NMmKGzJ0QG2-EPcc3TqY45et53I3_609");
  var pdfFolder = DriveApp.getFolderById("1fOCckAdqGdnRumdQxj0yBjcu2NzpbCq1");
  var tempFile = doc.makeCopy(tempFolder);
  var tempDocFile = DocumentApp.openById(tempFile.getId());


  var body = tempDocFile.getBody();
  var table = body.getTables()[0];
  var table1 = body.getTables()[1];
  body.replaceText ("{UNITGST}",gSTNumb);
  body.replaceText ("{VendorName}",vendorName);
  body.replaceText ("{VendorMobile}",vendorPhone);
  body.replaceText ("{currentDate}",poDate);
  body.replaceText ("{PONum}",poNumber);
  body.replaceText ("{UnitMobile}",unitPhone);
  body.replaceText ("{subTOTAL}",subT);
  body.replaceText ("{Shipping}",shipping);
  body.replaceText ("{OtherEXP}",oTher);
  body.replaceText ("{GrandTotal}",grandT);
  body.replaceText ("{addNotes}",addNotes);
  body.replaceText ("{UnitName1}",unitName1);
  body.replaceText ("{UnitName2}",unitName2);
  body.replaceText ("{Address1}",address1);
  body.replaceText ("{Address2}",address2);
  body.replaceText ("{paymentPercent}",payMent2);
//  body.replaceText ("{DateandTime}",dateTime1);
//  body.replaceText ("{VendorName2}",vendorName2);


  for (var i = 0; i < data.length; i++) {
    var row = table1.getRow(i+1);
    for (var j = 0; j < data[i].length; j++) {
      row.getCell(j).setText(data[i][j]);
    }
  }


  for (var k = 0; k < data2.length; k++) {
    var row1 = table.getRow(k);
    for (var l = 0; l < data2[k].length; l++) {
      row1.getCell(l).setText(data2[k][l]);
    }
  }


  tempDocFile.saveAndClose();
  var pdfCreate = tempFile.getAs(MimeType.PDF);
  var pdfLink = pdfFolder.createFile(pdfCreate).setName(poNumber);
  var pdfUrl = pdfLink.getUrl();
  tempFolder.removeFile(tempFile);


// UPDATE OF ALL ORDERS UNDER ONE P.O
copyDatapart2(pdfUrl);
}




function copyDatapart2(pdfURL) {
  var sheet1 = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("P.O");
  var sheet2 = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("P.Os");


  var lastRow = sheet2.getLastRow();
  var valueS8 = sheet1.getRange("S9").getValue();
  var valuePRICE = sheet1.getRange("R24:S54");  
  var valueI14 = sheet1.getRange("J15").getValue();
  var valueTent = sheet1.getRange("M19").getValue();
  var valueTAmount = sheet1.getRange("T59").getValue();


  var data = sheet1.getRange("J24:J54").getValues();
  var numRows = data.filter(String).length;
  if (numRows > 0) {
    var outputData = [];
    for (var i = 0; i < numRows; i++) {
      var timestamp = new Date();
      outputData.push([data[i][0], valueS8, pdfURL, timestamp, valueI14, valueTent, valueTAmount]);


      var progress = (i + 1) * 100 / numRows;
      var js = "<script>document.getElementById('progress').style.width = '" + progress + "%';</script>";
      html = HtmlService.createHtmlOutput(js);
      SpreadsheetApp.getUi().showModelessDialog(html, 'Finishing update. Kindly close this window if the script is not running.');
    }
    sheet2.getRange(lastRow + 1, 1, numRows, 7).setValues(outputData);
  }


  SpreadsheetApp.getUi().alert('PDF created successfully and P.O details updated!');
valuePRICE.clearContent();
}
